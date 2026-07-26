use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use chrono::{DateTime, Utc};
use serde::Serialize;
use sha2::{Digest, Sha256};
use siftlane_core::{AppError, EntryKind, ErrorCode, FileEntry};
use tauri::{AppHandle, Emitter, State};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

use crate::{
    commands::{normalize_remote_path, save_remote_bytes_atomic, session_client},
    state::AppState,
};

const MAX_EXTERNAL_EDIT_BYTES: u64 = 4 * 1024 * 1024;
const WATCH_INTERVAL: Duration = Duration::from_millis(500);

#[derive(Debug, Clone)]
pub struct ExternalEditRecord {
    pub id: Uuid,
    pub session_id: Uuid,
    pub remote_path: String,
    pub name: String,
    pub local_path: PathBuf,
    pub original: Vec<u8>,
    pub observed_hash: [u8; 32],
}

#[derive(Debug, Clone, Serialize)]
pub struct ExternalEditStarted {
    pub edit_id: Uuid,
    pub remote_path: String,
    pub name: String,
    pub local_path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExternalEditChanged {
    pub edit_id: Uuid,
    pub remote_path: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExternalEditChange {
    pub edit_id: Uuid,
    pub remote_path: String,
    pub name: String,
    pub original_content: String,
    pub modified_content: String,
}

#[tauri::command]
pub fn inspect_local_path(path: String) -> Result<FileEntry, AppError> {
    let path = PathBuf::from(path);
    let metadata = std::fs::symlink_metadata(&path).map_err(local_io_error)?;
    let kind = if metadata.file_type().is_symlink() {
        EntryKind::Symlink
    } else if metadata.is_dir() {
        EntryKind::Directory
    } else if metadata.is_file() {
        EntryKind::File
    } else {
        EntryKind::Other
    };
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| AppError::new(ErrorCode::InvalidInput, "The dropped path has no file name"))?
        .to_string();
    Ok(FileEntry {
        path: path.to_string_lossy().to_string(),
        name: name.clone(),
        kind,
        size: metadata.is_file().then_some(metadata.len()),
        modified_at: metadata.modified().ok().map(DateTime::<Utc>::from),
        permissions: local_permissions(&metadata),
        symlink_target: metadata
            .file_type()
            .is_symlink()
            .then(|| {
                std::fs::read_link(&path)
                    .ok()
                    .map(|target| target.to_string_lossy().to_string())
            })
            .flatten(),
        hidden: name.starts_with('.'),
    })
}

#[tauri::command]
pub async fn begin_external_edit(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: Uuid,
    path: String,
) -> Result<ExternalEditStarted, AppError> {
    let remote_path = normalize_remote_path(&path)?;
    let client = session_client(&state, session_id).await?;
    let metadata = client
        .metadata(&remote_path)
        .await?
        .ok_or_else(|| AppError::new(ErrorCode::NotFound, "The remote file no longer exists"))?;
    let size = metadata.size.unwrap_or(0);
    if size > MAX_EXTERNAL_EDIT_BYTES {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "Files larger than 4 MB cannot be reviewed safely before external upload",
        ));
    }

    let mut original = Vec::with_capacity(size as usize);
    let mut offset = 0;
    while offset < size {
        let chunk = client.read_chunk(&remote_path, offset, 64 * 1024).await?;
        if chunk.is_empty() {
            break;
        }
        offset += chunk.len() as u64;
        original.extend_from_slice(&chunk);
    }
    std::str::from_utf8(&original).map_err(|_| {
        AppError::new(
            ErrorCode::InvalidInput,
            "External editing currently supports UTF-8 text files",
        )
    })?;

    let id = Uuid::new_v4();
    let name = Path::new(&remote_path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("remote-file.txt")
        .to_string();
    let edit_dir = state.external_edit_root.path().join(id.to_string());
    tokio::fs::create_dir(&edit_dir)
        .await
        .map_err(local_io_error)?;
    set_private_directory_permissions(&edit_dir)?;
    let local_path = edit_dir.join(&name);
    let mut file = tokio::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&local_path)
        .await
        .map_err(local_io_error)?;
    file.write_all(&original).await.map_err(local_io_error)?;
    file.flush().await.map_err(local_io_error)?;
    file.sync_all().await.map_err(local_io_error)?;
    drop(file);
    set_private_file_permissions(&local_path)?;

    let record = ExternalEditRecord {
        id,
        session_id,
        remote_path: remote_path.clone(),
        name: name.clone(),
        local_path: local_path.clone(),
        observed_hash: hash(&original),
        original,
    };
    state.external_edits.lock().await.insert(id, record);
    spawn_watcher(app, state.inner().clone(), id);

    Ok(ExternalEditStarted {
        edit_id: id,
        remote_path,
        name,
        local_path: local_path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub async fn get_external_edit_change(
    state: State<'_, AppState>,
    edit_id: Uuid,
) -> Result<ExternalEditChange, AppError> {
    let record = state
        .external_edits
        .lock()
        .await
        .get(&edit_id)
        .cloned()
        .ok_or_else(|| {
            AppError::new(ErrorCode::NotFound, "The external edit is no longer active")
        })?;
    let modified = tokio::fs::read(&record.local_path)
        .await
        .map_err(local_io_error)?;
    if modified.len() as u64 > MAX_EXTERNAL_EDIT_BYTES {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "The edited file is now larger than the 4 MB review limit",
        ));
    }
    Ok(ExternalEditChange {
        edit_id,
        remote_path: record.remote_path,
        name: record.name,
        original_content: String::from_utf8(record.original).map_err(invalid_utf8)?,
        modified_content: String::from_utf8(modified).map_err(invalid_utf8)?,
    })
}

#[tauri::command]
pub async fn commit_external_edit(
    state: State<'_, AppState>,
    edit_id: Uuid,
) -> Result<(), AppError> {
    let record = state
        .external_edits
        .lock()
        .await
        .get(&edit_id)
        .cloned()
        .ok_or_else(|| {
            AppError::new(ErrorCode::NotFound, "The external edit is no longer active")
        })?;
    let modified = tokio::fs::read(&record.local_path)
        .await
        .map_err(local_io_error)?;
    if modified.len() as u64 > MAX_EXTERNAL_EDIT_BYTES {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "The edited file is now larger than the 4 MB review limit",
        ));
    }
    std::str::from_utf8(&modified).map_err(invalid_utf8)?;
    let client = session_client(&state, record.session_id).await?;
    save_remote_bytes_atomic(client.as_ref(), &record.remote_path, &modified).await?;

    if let Some(active) = state.external_edits.lock().await.get_mut(&edit_id) {
        active.original.clone_from(&modified);
        active.observed_hash = hash(&modified);
    }
    Ok(())
}

#[tauri::command]
pub async fn end_external_edit(state: State<'_, AppState>, edit_id: Uuid) -> Result<(), AppError> {
    let record = state.external_edits.lock().await.remove(&edit_id);
    if let Some(record) = record
        && let Some(directory) = record.local_path.parent()
    {
        match tokio::fs::remove_dir_all(directory).await {
            Ok(()) => {}
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => {}
            Err(source) => return Err(local_io_error(source)),
        }
    }
    Ok(())
}

fn spawn_watcher(app: AppHandle, state: AppState, edit_id: Uuid) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(WATCH_INTERVAL).await;
            let snapshot = {
                let edits = state.external_edits.lock().await;
                edits.get(&edit_id).cloned()
            };
            let Some(snapshot) = snapshot else { break };
            let Ok(contents) = tokio::fs::read(&snapshot.local_path).await else {
                continue;
            };
            let next_hash = hash(&contents);
            if next_hash == snapshot.observed_hash {
                continue;
            }
            let event = {
                let mut edits = state.external_edits.lock().await;
                let Some(active) = edits.get_mut(&edit_id) else {
                    break;
                };
                if active.observed_hash == next_hash {
                    continue;
                }
                active.observed_hash = next_hash;
                ExternalEditChanged {
                    edit_id: active.id,
                    remote_path: active.remote_path.clone(),
                    name: active.name.clone(),
                }
            };
            let _ = app.emit("external-edit-changed", event);
        }
    });
}

fn hash(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

fn invalid_utf8(source: impl std::fmt::Display) -> AppError {
    AppError::new(
        ErrorCode::InvalidInput,
        "External editing currently supports UTF-8 text files",
    )
    .with_detail(source.to_string())
}

fn local_io_error(source: std::io::Error) -> AppError {
    AppError::new(ErrorCode::Io, "A local file operation failed").with_detail(source.to_string())
}

#[cfg(unix)]
fn local_permissions(metadata: &std::fs::Metadata) -> Option<u32> {
    use std::os::unix::fs::PermissionsExt;
    Some(metadata.permissions().mode())
}

#[cfg(not(unix))]
fn local_permissions(_metadata: &std::fs::Metadata) -> Option<u32> {
    None
}

#[cfg(unix)]
fn set_private_directory_permissions(path: &Path) -> Result<(), AppError> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).map_err(local_io_error)
}

#[cfg(not(unix))]
fn set_private_directory_permissions(_path: &Path) -> Result<(), AppError> {
    Ok(())
}

#[cfg(unix)]
fn set_private_file_permissions(path: &Path) -> Result<(), AppError> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).map_err(local_io_error)
}

#[cfg(not(unix))]
fn set_private_file_permissions(_path: &Path) -> Result<(), AppError> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_change_with_contents() {
        assert_ne!(hash(b"before"), hash(b"after"));
        assert_eq!(hash(b"same"), hash(b"same"));
    }
}
