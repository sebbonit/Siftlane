use std::{
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Arc,
};

use chrono::{DateTime, Utc};
#[cfg(unix)]
use secrecy::ExposeSecret;
use secrecy::SecretString;
use serde::Deserialize;
use siftlane_core::{
    AppError, AuthRef, ConflictPolicy, ConnectResult, ConnectionProfile, EntryKind, ErrorCode,
    FileEntry, HostKeyChallenge, Preferences, Protocol, RemoteFilesystem, TransferDirection,
    TransferJob, TransferState,
};
use siftlane_ftp::{FtpClient, FtpConnectOptions, FtpSecurity};
use siftlane_sftp::{SftpAuth, SftpClient, SftpConnectOptions};
use tauri::{AppHandle, Manager, State};
#[cfg(unix)]
use tokio::{io::AsyncWriteExt, process::Command as TokioCommand};
use uuid::Uuid;

use crate::{
    secrets::SecretKind,
    state::{AppState, PendingHostKey, SessionRecord, StoredKeyVerifier},
    storage::StoredHostKey,
};

#[tauri::command]
pub fn list_profiles(state: State<'_, AppState>) -> Result<Vec<ConnectionProfile>, AppError> {
    state.storage.list_profiles()
}

#[tauri::command]
pub fn save_profile(
    state: State<'_, AppState>,
    mut profile: ConnectionProfile,
) -> Result<ConnectionProfile, AppError> {
    profile.label = profile.label.trim().to_string();
    profile.host = profile.host.trim().to_string();
    profile.username = profile.username.trim().to_string();
    profile.initial_remote_path = normalize_remote_path(&profile.initial_remote_path)?;
    if profile.label.is_empty() || profile.host.is_empty() || profile.username.is_empty() {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "Name, host, and username are required",
        ));
    }
    if profile.port == 0 {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "Port must be between 1 and 65535",
        ));
    }
    match (profile.protocol, &profile.auth) {
        (Protocol::Sftp, AuthRef::Anonymous) => {
            return Err(AppError::new(
                ErrorCode::InvalidInput,
                "SFTP does not support anonymous authentication",
            ));
        }
        (Protocol::Ftp | Protocol::Ftps, AuthRef::PrivateKey { .. } | AuthRef::Agent) => {
            return Err(AppError::new(
                ErrorCode::InvalidInput,
                "FTP and FTPS connections use a password or anonymous sign-in",
            ));
        }
        _ => {}
    }
    profile.updated_at = Utc::now();
    state.storage.save_profile(&profile)?;
    Ok(profile)
}

#[tauri::command]
pub async fn delete_profile(state: State<'_, AppState>, profile_id: Uuid) -> Result<(), AppError> {
    state.storage.delete_profile(profile_id)?;
    state.secrets.delete_profile(profile_id);
    let sessions_to_remove: Vec<Uuid> = state
        .sessions
        .read()
        .await
        .iter()
        .filter_map(|(id, session)| (session.profile_id == profile_id).then_some(*id))
        .collect();
    let mut sessions = state.sessions.write().await;
    for id in sessions_to_remove {
        sessions.remove(&id);
    }
    Ok(())
}

#[tauri::command]
pub async fn connect_profile(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: Uuid,
    credential: Option<String>,
) -> Result<ConnectResult, AppError> {
    let profile = state.storage.get_profile(profile_id)?;
    let preferences = state.storage.load_preferences()?;
    match profile.protocol {
        Protocol::Sftp => connect_sftp(&app, state.inner(), profile, credential, preferences).await,
        Protocol::Ftp | Protocol::Ftps => {
            connect_ftp(&app, state.inner(), profile, credential, preferences).await
        }
    }
}

async fn connect_sftp(
    app: &AppHandle,
    state: &AppState,
    profile: ConnectionProfile,
    credential: Option<String>,
    preferences: Preferences,
) -> Result<ConnectResult, AppError> {
    let (auth, supplied_secret) = resolve_sftp_auth(state, &profile, credential)?;
    let known_keys = state.storage.host_keys(&profile.host, profile.port)?;
    let verifier = Arc::new(StoredKeyVerifier::new(known_keys));
    let options = SftpConnectOptions {
        host: profile.host.clone(),
        port: profile.port,
        username: profile.username.clone(),
        auth,
        connect_timeout: std::time::Duration::from_secs(preferences.connect_timeout_seconds),
        response_timeout: std::time::Duration::from_secs(preferences.response_timeout_seconds),
        keepalive_interval: std::time::Duration::from_secs(preferences.keepalive_seconds),
    };
    match SftpClient::connect(options, verifier).await {
        Ok(client) => {
            persist_supplied_secret(state, &profile, supplied_secret)?;
            let session_id = Uuid::new_v4();
            state.sessions.write().await.insert(
                session_id,
                SessionRecord {
                    profile_id: profile.id,
                    client: Arc::new(client),
                },
            );
            resume_profile_transfers(app, state, profile.id).await?;
            Ok(ConnectResult::Connected { session_id })
        }
        Err(connect_error) => {
            if let Some(key) = connect_error.host_key {
                let challenge_id = Uuid::new_v4();
                let changed = connect_error.error.code == ErrorCode::HostKeyChanged;
                state
                    .pending_host_keys
                    .lock()
                    .await
                    .insert(challenge_id, PendingHostKey { key: key.clone() });
                Ok(ConnectResult::NeedsHostTrust {
                    challenge: HostKeyChallenge {
                        challenge_id,
                        host: key.host,
                        port: key.port,
                        algorithm: key.algorithm,
                        fingerprint_sha256: key.fingerprint_sha256,
                        changed,
                    },
                })
            } else {
                Err(connect_error.error)
            }
        }
    }
}

async fn connect_ftp(
    app: &AppHandle,
    state: &AppState,
    profile: ConnectionProfile,
    credential: Option<String>,
    preferences: Preferences,
) -> Result<ConnectResult, AppError> {
    let (password, supplied_secret) = resolve_ftp_password(state, &profile, credential)?;
    let security = if profile.protocol == Protocol::Ftps {
        FtpSecurity::ExplicitTls
    } else {
        FtpSecurity::Plain
    };
    let client = FtpClient::connect(FtpConnectOptions {
        host: profile.host.clone(),
        port: profile.port,
        username: profile.username.clone(),
        password,
        security,
        connect_timeout: std::time::Duration::from_secs(preferences.connect_timeout_seconds),
    })
    .await?;
    persist_supplied_secret(state, &profile, supplied_secret)?;
    let session_id = Uuid::new_v4();
    state.sessions.write().await.insert(
        session_id,
        SessionRecord {
            profile_id: profile.id,
            client: Arc::new(client),
        },
    );
    resume_profile_transfers(app, state, profile.id).await?;
    Ok(ConnectResult::Connected { session_id })
}

async fn resume_profile_transfers(
    app: &AppHandle,
    state: &AppState,
    profile_id: Uuid,
) -> Result<(), AppError> {
    let ids = {
        let mut queue = state.transfers.lock().await;
        let ids: Vec<_> = queue
            .list()
            .into_iter()
            .filter(|job| {
                job.profile_id == profile_id
                    && matches!(
                        job.state,
                        TransferState::Interrupted | TransferState::WaitingForAuthentication
                    )
            })
            .map(|job| job.id)
            .collect();
        for id in &ids {
            queue.transition(*id, TransferState::Queued)?;
            state
                .storage
                .save_transfer(queue.get(*id).expect("transfer exists"))?;
        }
        ids
    };
    for id in ids {
        crate::transfers::spawn(app.clone(), state.clone(), id);
    }
    Ok(())
}

#[tauri::command]
pub async fn trust_host_key(
    state: State<'_, AppState>,
    challenge_id: Uuid,
    accept: bool,
) -> Result<(), AppError> {
    let pending = state
        .pending_host_keys
        .lock()
        .await
        .remove(&challenge_id)
        .ok_or_else(|| AppError::new(ErrorCode::NotFound, "Host-key challenge expired"))?;
    if !accept {
        return Ok(());
    }
    state.storage.trust_host_key(&StoredHostKey {
        host: pending.key.host,
        port: pending.key.port,
        algorithm: pending.key.algorithm,
        fingerprint: pending.key.fingerprint_sha256,
    })
}

#[tauri::command]
pub async fn disconnect_session(
    state: State<'_, AppState>,
    session_id: Uuid,
) -> Result<(), AppError> {
    let session = state
        .sessions
        .write()
        .await
        .remove(&session_id)
        .ok_or_else(|| AppError::new(ErrorCode::NotFound, "Session not found"))?;
    session.client.disconnect().await
}

#[tauri::command]
pub async fn list_remote_directory(
    state: State<'_, AppState>,
    session_id: Uuid,
    path: String,
) -> Result<Vec<FileEntry>, AppError> {
    session_client(&state, session_id)
        .await?
        .list_directory(&normalize_remote_path(&path)?)
        .await
}

#[tauri::command]
pub fn get_default_local_path(app: AppHandle) -> Result<String, AppError> {
    app.path()
        .home_dir()
        .map(|path| path.to_string_lossy().to_string())
        .map_err(|source| {
            AppError::new(ErrorCode::Io, "Could not locate the home directory")
                .with_detail(source.to_string())
        })
}

#[tauri::command]
pub fn list_local_directory(path: String) -> Result<Vec<FileEntry>, AppError> {
    let mut entries = Vec::new();
    for item in std::fs::read_dir(&path).map_err(local_io_error)? {
        let item = item.map_err(local_io_error)?;
        let metadata = std::fs::symlink_metadata(item.path()).map_err(local_io_error)?;
        let kind = if metadata.file_type().is_symlink() {
            EntryKind::Symlink
        } else if metadata.is_dir() {
            EntryKind::Directory
        } else if metadata.is_file() {
            EntryKind::File
        } else {
            EntryKind::Other
        };
        let name = item.file_name().to_string_lossy().to_string();
        entries.push(FileEntry {
            path: item.path().to_string_lossy().to_string(),
            name: name.clone(),
            kind,
            size: metadata.is_file().then_some(metadata.len()),
            modified_at: metadata.modified().ok().map(DateTime::<Utc>::from),
            permissions: local_permissions(&metadata),
            symlink_target: metadata
                .file_type()
                .is_symlink()
                .then(|| {
                    std::fs::read_link(item.path())
                        .ok()
                        .map(|path| path.to_string_lossy().to_string())
                })
                .flatten(),
            hidden: name.starts_with('.'),
        });
    }
    entries.sort_by(|left, right| {
        let left_dir = left.kind == EntryKind::Directory;
        let right_dir = right.kind == EntryKind::Directory;
        right_dir
            .cmp(&left_dir)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    Ok(entries)
}

#[derive(serde::Serialize)]
pub struct EditableFile {
    pub path: String,
    pub name: String,
    pub content: String,
    pub language: String,
    pub size: usize,
    pub privileged: bool,
}

const MAX_EDITABLE_FILE_BYTES: u64 = 4 * 1024 * 1024;

#[tauri::command]
pub fn read_local_file(path: String) -> Result<EditableFile, AppError> {
    let bytes = std::fs::read(&path).map_err(local_io_error)?;
    editable_file(path, bytes)
}

#[tauri::command]
pub fn save_local_file(path: String, content: String) -> Result<(), AppError> {
    if content.len() as u64 > MAX_EDITABLE_FILE_BYTES {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "Files larger than 4 MB cannot be edited in Siftlane",
        ));
    }
    std::fs::write(path, content).map_err(local_io_error)
}

#[tauri::command]
pub async fn read_local_file_privileged(
    path: String,
    sudo_password: Option<String>,
) -> Result<EditableFile, AppError> {
    #[cfg(unix)]
    {
        let password = sudo_password.map(SecretString::from);
        let output = match run_local_sudo(&["cat", &path], None, &[]).await {
            Ok(output) => output,
            Err(error) => {
                let Some(password) = password.as_ref() else {
                    return Err(error);
                };
                run_local_sudo(&["cat", &path], Some(password), &[]).await?
            }
        };
        if output.len() as u64 > MAX_EDITABLE_FILE_BYTES {
            return Err(AppError::new(
                ErrorCode::InvalidInput,
                "Files larger than 4 MB cannot be edited in Siftlane",
            ));
        }
        let mut file = editable_file(path, output)?;
        file.privileged = true;
        Ok(file)
    }
    #[cfg(not(unix))]
    {
        let _ = (path, sudo_password);
        Err(AppError::new(
            ErrorCode::Unsupported,
            "Local sudo editing is supported on macOS and Linux only",
        ))
    }
}

#[tauri::command]
pub async fn save_local_file_privileged(
    path: String,
    content: String,
    sudo_password: Option<String>,
) -> Result<(), AppError> {
    if content.len() as u64 > MAX_EDITABLE_FILE_BYTES {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "Files larger than 4 MB cannot be edited in Siftlane",
        ));
    }
    #[cfg(unix)]
    {
        let password = sudo_password.map(SecretString::from);
        let probe = run_local_sudo(&["true"], None, &[]).await;
        if probe.is_ok() {
            run_local_sudo(&["tee", &path], None, content.as_bytes()).await?;
            return Ok(());
        }
        let Some(password) = password.as_ref() else {
            return Err(probe.expect_err("sudo probe must contain an error"));
        };
        run_local_sudo(&["tee", &path], Some(password), content.as_bytes())
            .await
            .map(|_| ())
    }
    #[cfg(not(unix))]
    {
        let _ = (path, content, sudo_password);
        Err(AppError::new(
            ErrorCode::Unsupported,
            "Local sudo editing is supported on macOS and Linux only",
        ))
    }
}

#[tauri::command]
pub async fn create_local_entry_privileged(
    parent_path: String,
    name: String,
    directory: bool,
    sudo_password: Option<String>,
) -> Result<(), AppError> {
    validate_entry_name(&name)?;
    let path = Path::new(&parent_path)
        .join(name)
        .to_string_lossy()
        .to_string();
    #[cfg(unix)]
    {
        let args = if directory {
            vec!["mkdir".to_string(), path.clone()]
        } else {
            vec![
                "sh".to_string(),
                "-c".to_string(),
                "set -C; : > \"$1\"".to_string(),
                "siftlane".to_string(),
                path.clone(),
            ]
        };
        let refs = args.iter().map(String::as_str).collect::<Vec<_>>();
        let password = sudo_password.map(SecretString::from);
        run_local_sudo(&refs, password.as_ref(), &[])
            .await
            .map(|_| ())
    }
    #[cfg(not(unix))]
    {
        let _ = (path, directory, sudo_password);
        Err(AppError::new(
            ErrorCode::Unsupported,
            "Local sudo editing is supported on macOS and Linux only",
        ))
    }
}

#[tauri::command]
pub async fn delete_local_entry_privileged(
    path: String,
    directory: bool,
    sudo_password: Option<String>,
) -> Result<(), AppError> {
    #[cfg(unix)]
    {
        let command = if directory { "rmdir" } else { "rm" };
        let password = sudo_password.map(SecretString::from);
        run_local_sudo(&[command, &path], password.as_ref(), &[])
            .await
            .map(|_| ())
    }
    #[cfg(not(unix))]
    {
        let _ = (path, directory, sudo_password);
        Err(AppError::new(
            ErrorCode::Unsupported,
            "Local sudo editing is supported on macOS and Linux only",
        ))
    }
}

#[cfg(unix)]
async fn run_local_sudo(
    args: &[&str],
    password: Option<&SecretString>,
    content: &[u8],
) -> Result<Vec<u8>, AppError> {
    let mut command = TokioCommand::new("sudo");
    command
        .args(["-n", "--"])
        .args(args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let output = if let Some(password) = password {
        let _ = TokioCommand::new("sudo")
            .args(["-k"])
            .status()
            .await
            .map_err(local_sudo_spawn_error)?;
        let mut command = TokioCommand::new("sudo");
        command
            .args(["-S", "-p", "", "--"])
            .args(args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let mut child = command.spawn().map_err(local_sudo_spawn_error)?;
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(password.expose_secret().as_bytes())
                .await
                .map_err(|error| {
                    AppError::new(ErrorCode::Io, "Could not send the sudo password")
                        .with_detail(error.to_string())
                })?;
            stdin.write_all(b"\n").await.map_err(|error| {
                AppError::new(ErrorCode::Io, "Could not send the sudo password")
                    .with_detail(error.to_string())
            })?;
            stdin.write_all(content).await.map_err(|error| {
                AppError::new(ErrorCode::Io, "Could not send the file to sudo")
                    .with_detail(error.to_string())
            })?;
        }
        child
            .wait_with_output()
            .await
            .map_err(local_sudo_spawn_error)?
    } else {
        command.output().await.map_err(local_sudo_spawn_error)?
    };
    if !output.status.success() {
        return Err(local_sudo_error(&output.stderr));
    }
    if output.stdout.len() as u64 > MAX_EDITABLE_FILE_BYTES {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "Files larger than 4 MB cannot be edited in Siftlane",
        ));
    }
    Ok(output.stdout)
}

#[cfg(unix)]
fn local_sudo_spawn_error(error: std::io::Error) -> AppError {
    AppError::new(
        ErrorCode::Unsupported,
        "The local sudo command could not be started",
    )
    .with_detail(error.to_string())
}

#[cfg(unix)]
fn local_sudo_error(stderr: &[u8]) -> AppError {
    let detail = String::from_utf8_lossy(stderr).trim().to_string();
    let lower = detail.to_ascii_lowercase();
    let code = if lower.contains("password") || lower.contains("authentication") {
        ErrorCode::AuthenticationFailed
    } else if lower.contains("file exists") || lower.contains("already exists") {
        ErrorCode::AlreadyExists
    } else if lower.contains("no such file") {
        ErrorCode::NotFound
    } else {
        ErrorCode::PermissionDenied
    };
    AppError::new(code, "The local sudo operation failed").with_detail(detail)
}

#[tauri::command]
pub fn format_rust(content: String) -> Result<String, AppError> {
    let mut child = Command::new("rustfmt")
        .args(["--emit", "stdout", "--edition", "2024"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            AppError::new(
                ErrorCode::Unsupported,
                "rustfmt is not installed on this computer",
            )
            .with_detail(error.to_string())
        })?;
    child
        .stdin
        .take()
        .ok_or_else(|| AppError::new(ErrorCode::Internal, "Could not start rustfmt"))?
        .write_all(content.as_bytes())
        .map_err(|error| {
            AppError::new(ErrorCode::Io, "Could not send the file to rustfmt")
                .with_detail(error.to_string())
        })?;
    let output = child.wait_with_output().map_err(|error| {
        AppError::new(ErrorCode::Io, "rustfmt could not finish").with_detail(error.to_string())
    })?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "rustfmt could not format this file",
        )
        .with_detail(detail));
    }
    String::from_utf8(output.stdout).map_err(|error| {
        AppError::new(ErrorCode::Internal, "rustfmt returned invalid text")
            .with_detail(error.to_string())
    })
}

#[tauri::command]
pub async fn read_remote_file(
    state: State<'_, AppState>,
    session_id: Uuid,
    path: String,
) -> Result<EditableFile, AppError> {
    let path = normalize_remote_path(&path)?;
    let client = session_client(&state, session_id).await?;
    let metadata = client
        .metadata(&path)
        .await?
        .ok_or_else(|| AppError::new(ErrorCode::NotFound, "The remote file no longer exists"))?;
    let size = metadata.size.unwrap_or(0);
    if size > MAX_EDITABLE_FILE_BYTES {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "Files larger than 4 MB cannot be edited in Siftlane",
        ));
    }
    let mut bytes = Vec::with_capacity(size as usize);
    let mut offset = 0;
    while offset < size {
        let chunk = client.read_chunk(&path, offset, 64 * 1024).await?;
        if chunk.is_empty() {
            break;
        }
        offset += chunk.len() as u64;
        bytes.extend_from_slice(&chunk);
    }
    editable_file(path, bytes)
}

#[tauri::command]
pub async fn read_remote_file_privileged(
    state: State<'_, AppState>,
    session_id: Uuid,
    path: String,
    sudo_password: Option<String>,
) -> Result<EditableFile, AppError> {
    let path = normalize_remote_path(&path)?;
    let password = sudo_password.map(SecretString::from);
    let bytes = session_client(&state, session_id)
        .await?
        .read_privileged(&path, password.as_ref())
        .await?;
    if bytes.len() as u64 > MAX_EDITABLE_FILE_BYTES {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "Files larger than 4 MB cannot be edited in Siftlane",
        ));
    }
    let mut file = editable_file(path, bytes)?;
    file.privileged = true;
    Ok(file)
}

#[tauri::command]
pub async fn save_remote_file(
    state: State<'_, AppState>,
    session_id: Uuid,
    path: String,
    content: String,
) -> Result<(), AppError> {
    if content.len() as u64 > MAX_EDITABLE_FILE_BYTES {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "Files larger than 4 MB cannot be edited in Siftlane",
        ));
    }
    let path = normalize_remote_path(&path)?;
    let client = session_client(&state, session_id).await?;
    let parent = path
        .rsplit_once('/')
        .map(|(parent, _)| if parent.is_empty() { "/" } else { parent })
        .unwrap_or("/");
    let name = path.rsplit('/').next().unwrap_or("file");
    let temp = normalize_remote_path(&format!(
        "{}/.siftlane-edit-{}-{}",
        parent.trim_end_matches('/'),
        Uuid::new_v4(),
        name
    ))?;
    if content.is_empty() {
        client.write_chunk(&temp, 0, &[]).await?;
    } else {
        for (offset, chunk) in content.as_bytes().chunks(64 * 1024).enumerate() {
            client
                .write_chunk(&temp, (offset * 64 * 1024) as u64, chunk)
                .await?;
        }
    }
    client.sync_file(&temp).await?;
    let backup = normalize_remote_path(&format!(
        "{}/.siftlane-backup-{}-{}",
        parent.trim_end_matches('/'),
        Uuid::new_v4(),
        name
    ))?;
    client.rename(&path, &backup).await?;
    if let Err(error) = client.rename(&temp, &path).await {
        let _ = client.rename(&backup, &path).await;
        let _ = client.remove_file(&temp).await;
        return Err(error);
    }
    client.remove_file(&backup).await
}

#[tauri::command]
pub async fn save_remote_file_privileged(
    state: State<'_, AppState>,
    session_id: Uuid,
    path: String,
    content: String,
    sudo_password: Option<String>,
) -> Result<(), AppError> {
    if content.len() as u64 > MAX_EDITABLE_FILE_BYTES {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "Files larger than 4 MB cannot be edited in Siftlane",
        ));
    }
    let path = normalize_remote_path(&path)?;
    let password = sudo_password.map(SecretString::from);
    session_client(&state, session_id)
        .await?
        .write_privileged(&path, content.as_bytes(), password.as_ref())
        .await
}

fn editable_file(path: String, bytes: Vec<u8>) -> Result<EditableFile, AppError> {
    let name = Path::new(&path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("file.txt")
        .to_string();
    let content = String::from_utf8(bytes).map_err(|_| {
        AppError::new(
            ErrorCode::InvalidInput,
            "This file is binary and cannot be edited as text",
        )
    })?;
    let size = content.len();
    Ok(EditableFile {
        language: language_for(&name).to_string(),
        path,
        name,
        content,
        size,
        privileged: false,
    })
}

fn language_for(name: &str) -> &'static str {
    match Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "html" | "htm" => "HTML",
        "css" => "CSS",
        "ts" | "tsx" => "TypeScript",
        "js" | "jsx" => "JavaScript",
        "json" => "JSON",
        "md" => "Markdown",
        "rs" => "Rust",
        _ => "Plain text",
    }
}

#[tauri::command]
pub fn create_local_entry(
    parent_path: String,
    name: String,
    directory: bool,
) -> Result<(), AppError> {
    validate_entry_name(&name)?;
    let path = Path::new(&parent_path).join(name);
    if directory {
        std::fs::create_dir(&path).map_err(local_io_error)
    } else {
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map(|_| ())
            .map_err(local_io_error)
    }
}

#[tauri::command]
pub fn delete_local_entry(path: String, directory: bool) -> Result<(), AppError> {
    if directory {
        std::fs::remove_dir(path).map_err(local_io_error)
    } else {
        std::fs::remove_file(path).map_err(local_io_error)
    }
}

#[tauri::command]
pub async fn create_remote_entry(
    state: State<'_, AppState>,
    session_id: Uuid,
    parent_path: String,
    name: String,
    directory: bool,
) -> Result<(), AppError> {
    validate_entry_name(&name)?;
    let parent = normalize_remote_path(&parent_path)?;
    let path = normalize_remote_path(&format!("{}/{}", parent.trim_end_matches('/'), name))?;
    let client = session_client(&state, session_id).await?;
    if client.metadata(&path).await?.is_some() {
        return Err(AppError::new(
            ErrorCode::AlreadyExists,
            "An entry with that name already exists",
        ));
    }
    if directory {
        client.create_directory(&path).await
    } else {
        client.write_chunk(&path, 0, &[]).await
    }
}

#[tauri::command]
pub async fn create_remote_entry_privileged(
    state: State<'_, AppState>,
    session_id: Uuid,
    parent_path: String,
    name: String,
    directory: bool,
    sudo_password: Option<String>,
) -> Result<(), AppError> {
    validate_entry_name(&name)?;
    let parent = normalize_remote_path(&parent_path)?;
    let path = normalize_remote_path(&format!("{}/{}", parent.trim_end_matches('/'), name))?;
    let password = sudo_password.map(SecretString::from);
    session_client(&state, session_id)
        .await?
        .create_privileged(&path, directory, password.as_ref())
        .await
}

#[tauri::command]
pub async fn rename_remote_entry(
    state: State<'_, AppState>,
    session_id: Uuid,
    from: String,
    to: String,
) -> Result<(), AppError> {
    session_client(&state, session_id)
        .await?
        .rename(&normalize_remote_path(&from)?, &normalize_remote_path(&to)?)
        .await
}

#[tauri::command]
pub async fn delete_remote_entry(
    state: State<'_, AppState>,
    session_id: Uuid,
    path: String,
    directory: bool,
) -> Result<(), AppError> {
    let client = session_client(&state, session_id).await?;
    let path = normalize_remote_path(&path)?;
    if directory {
        client.remove_directory(&path).await
    } else {
        client.remove_file(&path).await
    }
}

#[tauri::command]
pub async fn delete_remote_entry_privileged(
    state: State<'_, AppState>,
    session_id: Uuid,
    path: String,
    directory: bool,
    sudo_password: Option<String>,
) -> Result<(), AppError> {
    let path = normalize_remote_path(&path)?;
    let password = sudo_password.map(SecretString::from);
    session_client(&state, session_id)
        .await?
        .delete_privileged(&path, directory, password.as_ref())
        .await
}

#[tauri::command]
pub async fn set_remote_permissions(
    state: State<'_, AppState>,
    session_id: Uuid,
    path: String,
    permissions: u32,
) -> Result<(), AppError> {
    if permissions > 0o7777 {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "Invalid POSIX permissions",
        ));
    }
    session_client(&state, session_id)
        .await?
        .set_permissions(&normalize_remote_path(&path)?, permissions)
        .await
}

#[tauri::command]
pub fn get_preferences(state: State<'_, AppState>) -> Result<Preferences, AppError> {
    state.storage.load_preferences()
}

#[tauri::command]
pub fn save_preferences(
    state: State<'_, AppState>,
    preferences: Preferences,
) -> Result<(), AppError> {
    if preferences.global_parallel_transfers == 0 || preferences.per_host_parallel_transfers == 0 {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "Transfer concurrency must be at least one",
        ));
    }
    state.storage.save_preferences(&preferences)
}

#[tauri::command]
pub async fn list_transfers(state: State<'_, AppState>) -> Result<Vec<TransferJob>, AppError> {
    Ok(state.transfers.lock().await.list())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferDraft {
    pub profile_id: Uuid,
    pub direction: TransferDirection,
    pub source_path: String,
    pub destination_path: String,
    pub conflict_policy: Option<ConflictPolicy>,
}

#[tauri::command]
pub async fn enqueue_transfer(
    app: AppHandle,
    state: State<'_, AppState>,
    draft: TransferDraft,
) -> Result<TransferJob, AppError> {
    if draft.source_path.is_empty() || draft.destination_path.is_empty() {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "Source and destination are required",
        ));
    }
    let mut job = TransferJob::new(
        draft.profile_id,
        draft.direction,
        draft.source_path,
        draft.destination_path,
        None,
    );
    if let Some(policy) = draft.conflict_policy {
        job.conflict_policy = policy;
    }
    {
        let mut queue = state.transfers.lock().await;
        queue.enqueue(job.clone());
        state.storage.save_transfer(&job)?;
    }
    crate::transfers::spawn(app, state.inner().clone(), job.id);
    Ok(job)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransferAction {
    Pause,
    Resume,
    Cancel,
    Retry,
}

#[tauri::command]
pub async fn control_transfer(
    app: AppHandle,
    state: State<'_, AppState>,
    transfer_id: Uuid,
    action: TransferAction,
) -> Result<TransferJob, AppError> {
    let should_spawn = {
        let mut queue = state.transfers.lock().await;
        let next = match action {
            TransferAction::Pause => TransferState::Paused,
            TransferAction::Cancel => TransferState::Cancelled,
            TransferAction::Resume | TransferAction::Retry => TransferState::Queued,
        };
        queue.transition(transfer_id, next)?;
        queue.set_error(transfer_id, None)?;
        let job = queue.get(transfer_id).cloned().expect("transfer exists");
        state.storage.save_transfer(&job)?;
        matches!(action, TransferAction::Resume | TransferAction::Retry)
    };
    if should_spawn {
        crate::transfers::spawn(app, state.inner().clone(), transfer_id);
    }
    state
        .transfers
        .lock()
        .await
        .get(transfer_id)
        .cloned()
        .ok_or_else(|| AppError::new(ErrorCode::NotFound, "Transfer not found"))
}

#[tauri::command]
pub async fn resolve_transfer_conflict(
    app: AppHandle,
    state: State<'_, AppState>,
    transfer_id: Uuid,
    policy: ConflictPolicy,
) -> Result<TransferJob, AppError> {
    if matches!(policy, ConflictPolicy::Ask | ConflictPolicy::Rename) {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "Resolve the conflict with skip or overwrite",
        ));
    }
    {
        let mut queue = state.transfers.lock().await;
        queue.update_conflict_policy(transfer_id, policy)?;
        queue.transition(transfer_id, TransferState::Queued)?;
        state
            .storage
            .save_transfer(queue.get(transfer_id).expect("transfer exists"))?;
    }
    crate::transfers::spawn(app, state.inner().clone(), transfer_id);
    state
        .transfers
        .lock()
        .await
        .get(transfer_id)
        .cloned()
        .ok_or_else(|| AppError::new(ErrorCode::NotFound, "Transfer not found"))
}

async fn session_client(
    state: &AppState,
    session_id: Uuid,
) -> Result<Arc<dyn RemoteFilesystem>, AppError> {
    state
        .sessions
        .read()
        .await
        .get(&session_id)
        .map(|session| session.client.clone())
        .ok_or_else(|| {
            AppError::new(
                ErrorCode::ConnectionClosed,
                "The remote session is not connected",
            )
        })
}

fn resolve_sftp_auth(
    state: &AppState,
    profile: &ConnectionProfile,
    credential: Option<String>,
) -> Result<(SftpAuth, Option<(SecretKind, String)>), AppError> {
    match &profile.auth {
        AuthRef::Password { .. } => {
            let supplied = credential.map(|value| (SecretKind::Password, value));
            let secret = supplied
                .as_ref()
                .map(|(_, value)| SecretString::from(value.clone()))
                .or(state.secrets.get(profile.id, SecretKind::Password)?)
                .ok_or_else(|| {
                    AppError::new(ErrorCode::AuthenticationFailed, "A password is required")
                })?;
            Ok((SftpAuth::Password(secret), supplied))
        }
        AuthRef::PrivateKey { path, .. } => {
            let key_path = expand_home_path(path);
            if !key_path.is_file() {
                return Err(AppError::new(
                    ErrorCode::NotFound,
                    "Private key file was not found. Choose it again in the connection settings.",
                )
                .with_detail(key_path.to_string_lossy()));
            }
            let supplied = credential.map(|value| (SecretKind::PrivateKeyPassphrase, value));
            let passphrase = supplied
                .as_ref()
                .map(|(_, value)| SecretString::from(value.clone()))
                .or(state
                    .secrets
                    .get(profile.id, SecretKind::PrivateKeyPassphrase)?);
            Ok((
                SftpAuth::PrivateKey {
                    path: key_path,
                    passphrase,
                },
                supplied,
            ))
        }
        AuthRef::Agent => Ok((SftpAuth::Agent, None)),
        AuthRef::Anonymous => Err(AppError::new(
            ErrorCode::InvalidInput,
            "SFTP does not support anonymous authentication",
        )),
    }
}

fn resolve_ftp_password(
    state: &AppState,
    profile: &ConnectionProfile,
    credential: Option<String>,
) -> Result<(SecretString, Option<(SecretKind, String)>), AppError> {
    match &profile.auth {
        AuthRef::Anonymous => Ok((SecretString::from("anonymous@"), None)),
        AuthRef::Password { .. } => {
            let supplied = credential.map(|value| (SecretKind::Password, value));
            let password = supplied
                .as_ref()
                .map(|(_, value)| SecretString::from(value.clone()))
                .or(state.secrets.get(profile.id, SecretKind::Password)?)
                .ok_or_else(|| {
                    AppError::new(ErrorCode::AuthenticationFailed, "A password is required")
                })?;
            Ok((password, supplied))
        }
        AuthRef::PrivateKey { .. } | AuthRef::Agent => Err(AppError::new(
            ErrorCode::InvalidInput,
            "FTP and FTPS connections use a password or anonymous sign-in",
        )),
    }
}

fn expand_home_path(path: &str) -> PathBuf {
    let Some(relative) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) else {
        return Path::new(path).to_path_buf();
    };
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .map(|home| home.join(relative))
        .unwrap_or_else(|| Path::new(path).to_path_buf())
}

fn persist_supplied_secret(
    state: &AppState,
    profile: &ConnectionProfile,
    supplied: Option<(SecretKind, String)>,
) -> Result<(), AppError> {
    let Some((kind, value)) = supplied else {
        return Ok(());
    };
    let remember = match profile.auth {
        AuthRef::Anonymous => false,
        AuthRef::Password { remember } => remember,
        AuthRef::PrivateKey {
            remember_passphrase,
            ..
        } => remember_passphrase,
        AuthRef::Agent => false,
    };
    if remember {
        state.secrets.set(profile.id, kind, &value)?;
    }
    Ok(())
}

fn normalize_remote_path(path: &str) -> Result<String, AppError> {
    if path.contains('\0') {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "Remote path contains a null byte",
        ));
    }
    let absolute = if path.trim().is_empty() {
        "/"
    } else {
        path.trim()
    };
    let mut segments = Vec::new();
    for segment in absolute.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                segments.pop();
            }
            value => segments.push(value),
        }
    }
    Ok(format!("/{}", segments.join("/")))
}

fn validate_entry_name(name: &str) -> Result<(), AppError> {
    if name.trim().is_empty() || matches!(name, "." | "..") || name.contains(['/', '\\', '\0']) {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "Enter a single valid file or folder name",
        ));
    }
    Ok(())
}

fn local_io_error(source: std::io::Error) -> AppError {
    let code = match source.kind() {
        std::io::ErrorKind::NotFound => ErrorCode::NotFound,
        std::io::ErrorKind::PermissionDenied => ErrorCode::PermissionDenied,
        _ => ErrorCode::Io,
    };
    AppError::new(code, "The local directory could not be read").with_detail(source.to_string())
}

#[cfg(unix)]
fn local_permissions(metadata: &std::fs::Metadata) -> Option<u32> {
    use std::os::unix::fs::PermissionsExt;
    Some(metadata.permissions().mode() & 0o7777)
}

#[cfg(not(unix))]
fn local_permissions(_: &std::fs::Metadata) -> Option<u32> {
    None
}

#[cfg(test)]
mod tests {
    use super::normalize_remote_path;
    #[cfg(unix)]
    use super::{ErrorCode, local_sudo_error};

    #[test]
    fn remote_paths_are_absolute_and_normalized() {
        assert_eq!(
            normalize_remote_path("/var/www/../html").unwrap(),
            "/var/html"
        );
        assert_eq!(normalize_remote_path("").unwrap(), "/");
    }

    #[cfg(unix)]
    #[test]
    fn sudo_errors_distinguish_authentication_and_authorization() {
        assert_eq!(
            local_sudo_error(b"sudo: a password is required").code,
            ErrorCode::AuthenticationFailed
        );
        assert_eq!(
            local_sudo_error(b"user is not allowed to run sudo").code,
            ErrorCode::PermissionDenied
        );
    }
}
