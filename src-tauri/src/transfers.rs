use std::{path::Path, sync::Arc, time::Instant};

use siftlane_core::{
    AppError, ConflictPolicy, ErrorCode, RemoteFilesystem, TransferDirection, TransferId,
    TransferProgress, TransferState,
};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

use crate::state::AppState;

const CHUNK_SIZE: usize = 256 * 1024;

pub fn spawn(app: AppHandle, state: AppState, id: TransferId) {
    tauri::async_runtime::spawn(async move {
        if let Err(error) = run(app.clone(), state.clone(), id).await {
            let _ = fail(&app, &state, id, error).await;
        }
    });
}

async fn run(app: AppHandle, state: AppState, id: TransferId) -> Result<(), AppError> {
    let _slot =
        state.transfer_slots.acquire().await.map_err(|_| {
            AppError::new(ErrorCode::Internal, "The transfer scheduler has stopped")
        })?;
    let job = {
        let mut queue = state.transfers.lock().await;
        let job = queue
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::new(ErrorCode::NotFound, "Transfer not found"))?;
        if matches!(
            job.state,
            TransferState::Queued | TransferState::Interrupted
        ) {
            queue.transition(id, TransferState::Running)?;
        }
        let updated = queue.get(id).cloned().expect("transfer exists");
        state.storage.save_transfer(&updated)?;
        updated
    };
    emit(&app, &progress_from_job(job.clone()));

    let remote = state
        .sessions
        .read()
        .await
        .values()
        .find(|session| session.profile_id == job.profile_id)
        .map(|session| session.client.clone())
        .ok_or_else(|| {
            AppError::new(
                ErrorCode::ConnectionClosed,
                "Reconnect the profile before resuming this transfer",
            )
        })?;

    match job.direction {
        TransferDirection::Upload => upload(&app, &state, remote, id).await,
        TransferDirection::Download => download(&app, &state, remote, id).await,
    }
}

async fn upload(
    app: &AppHandle,
    state: &AppState,
    remote: Arc<dyn RemoteFilesystem>,
    id: TransferId,
) -> Result<(), AppError> {
    let job = job_snapshot(state, id).await?;
    let source_metadata = tokio::fs::metadata(&job.source_path)
        .await
        .map_err(local_io_error)?;
    set_total(state, id, source_metadata.len()).await?;
    if handle_remote_conflict(state, remote.as_ref(), id).await? {
        emit_current(app, state, id).await;
        return Ok(());
    }

    let partial_size = remote
        .metadata(&job.partial_path)
        .await?
        .and_then(|entry| entry.size)
        .unwrap_or(0)
        .min(source_metadata.len());
    let mut source = tokio::fs::File::open(&job.source_path)
        .await
        .map_err(local_io_error)?;
    source
        .seek(std::io::SeekFrom::Start(partial_size))
        .await
        .map_err(local_io_error)?;
    let mut offset = partial_size;
    let mut buffer = vec![0; CHUNK_SIZE];
    let started = Instant::now();
    while offset < source_metadata.len() {
        ensure_running(state, id).await?;
        let count = source.read(&mut buffer).await.map_err(local_io_error)?;
        if count == 0 {
            break;
        }
        remote
            .write_chunk(&job.partial_path, offset, &buffer[..count])
            .await?;
        offset += count as u64;
        record_progress(app, state, id, offset, started).await?;
    }
    remote.sync_file(&job.partial_path).await?;
    commit_remote(state, remote.as_ref(), id).await?;
    complete(app, state, id).await
}

async fn download(
    app: &AppHandle,
    state: &AppState,
    remote: Arc<dyn RemoteFilesystem>,
    id: TransferId,
) -> Result<(), AppError> {
    let job = job_snapshot(state, id).await?;
    let source = remote
        .metadata(&job.source_path)
        .await?
        .ok_or_else(|| AppError::new(ErrorCode::NotFound, "The remote source no longer exists"))?;
    let total = source.size.ok_or_else(|| {
        AppError::new(
            ErrorCode::Unsupported,
            "The remote server did not report a file size",
        )
    })?;
    set_total(state, id, total).await?;
    if handle_local_conflict(state, id).await? {
        emit_current(app, state, id).await;
        return Ok(());
    }
    if let Some(parent) = Path::new(&job.partial_path).parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(local_io_error)?;
    }
    let mut destination = tokio::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&job.partial_path)
        .await
        .map_err(local_io_error)?;
    let mut offset = destination
        .metadata()
        .await
        .map_err(local_io_error)?
        .len()
        .min(total);
    destination.set_len(offset).await.map_err(local_io_error)?;
    destination
        .seek(std::io::SeekFrom::Start(offset))
        .await
        .map_err(local_io_error)?;
    let started = Instant::now();
    while offset < total {
        ensure_running(state, id).await?;
        let remaining = (total - offset).min(CHUNK_SIZE as u64) as u32;
        let bytes = remote
            .read_chunk(&job.source_path, offset, remaining)
            .await?;
        if bytes.is_empty() {
            return Err(AppError::new(
                ErrorCode::Io,
                "The remote file ended before its advertised size",
            ));
        }
        destination
            .write_all(&bytes)
            .await
            .map_err(local_io_error)?;
        offset += bytes.len() as u64;
        record_progress(app, state, id, offset, started).await?;
    }
    destination.flush().await.map_err(local_io_error)?;
    destination.sync_all().await.map_err(local_io_error)?;
    drop(destination);
    commit_local(state, id).await?;
    complete(app, state, id).await
}

async fn handle_remote_conflict(
    state: &AppState,
    remote: &dyn RemoteFilesystem,
    id: TransferId,
) -> Result<bool, AppError> {
    let job = job_snapshot(state, id).await?;
    if remote.metadata(&job.destination_path).await?.is_none() {
        return Ok(false);
    }
    match job.conflict_policy {
        ConflictPolicy::Ask => {
            transition(state, id, TransferState::WaitingForConflict).await?;
            Ok(true)
        }
        ConflictPolicy::Skip => {
            transition(state, id, TransferState::Completed).await?;
            Ok(true)
        }
        ConflictPolicy::Overwrite => Ok(false),
        ConflictPolicy::Rename => Err(AppError::new(
            ErrorCode::Unsupported,
            "Choose a new destination name before resuming the transfer",
        )),
    }
}

async fn handle_local_conflict(state: &AppState, id: TransferId) -> Result<bool, AppError> {
    let job = job_snapshot(state, id).await?;
    if !tokio::fs::try_exists(&job.destination_path)
        .await
        .map_err(local_io_error)?
    {
        return Ok(false);
    }
    match job.conflict_policy {
        ConflictPolicy::Ask => {
            transition(state, id, TransferState::WaitingForConflict).await?;
            Ok(true)
        }
        ConflictPolicy::Skip => {
            transition(state, id, TransferState::Completed).await?;
            Ok(true)
        }
        ConflictPolicy::Overwrite => Ok(false),
        ConflictPolicy::Rename => Err(AppError::new(
            ErrorCode::Unsupported,
            "Choose a new destination name before resuming the transfer",
        )),
    }
}

async fn commit_remote(
    state: &AppState,
    remote: &dyn RemoteFilesystem,
    id: TransferId,
) -> Result<(), AppError> {
    let job = job_snapshot(state, id).await?;
    if remote.metadata(&job.destination_path).await?.is_none() {
        return remote
            .rename(&job.partial_path, &job.destination_path)
            .await;
    }
    let backup = format!("{}.siftlane-backup-{}", job.destination_path, job.id);
    remote.rename(&job.destination_path, &backup).await?;
    if let Err(error) = remote
        .rename(&job.partial_path, &job.destination_path)
        .await
    {
        let _ = remote.rename(&backup, &job.destination_path).await;
        return Err(error);
    }
    remote.remove_file(&backup).await
}

async fn commit_local(state: &AppState, id: TransferId) -> Result<(), AppError> {
    let job = job_snapshot(state, id).await?;
    if !tokio::fs::try_exists(&job.destination_path)
        .await
        .map_err(local_io_error)?
    {
        return tokio::fs::rename(&job.partial_path, &job.destination_path)
            .await
            .map_err(local_io_error);
    }
    let backup = format!("{}.siftlane-backup-{}", job.destination_path, job.id);
    tokio::fs::rename(&job.destination_path, &backup)
        .await
        .map_err(local_io_error)?;
    if let Err(error) = tokio::fs::rename(&job.partial_path, &job.destination_path).await {
        let _ = tokio::fs::rename(&backup, &job.destination_path).await;
        return Err(local_io_error(error));
    }
    tokio::fs::remove_file(backup).await.map_err(local_io_error)
}

async fn ensure_running(state: &AppState, id: TransferId) -> Result<(), AppError> {
    let job = job_snapshot(state, id).await?;
    match job.state {
        TransferState::Running => Ok(()),
        TransferState::Paused => Err(AppError::new(ErrorCode::Conflict, "Transfer paused")),
        TransferState::Cancelled => Err(AppError::new(ErrorCode::Conflict, "Transfer cancelled")),
        _ => Err(AppError::new(
            ErrorCode::Conflict,
            "Transfer is no longer running",
        )),
    }
}

async fn set_total(state: &AppState, id: TransferId, total: u64) -> Result<(), AppError> {
    let mut queue = state.transfers.lock().await;
    queue.update_total(id, total)?;
    state
        .storage
        .save_transfer(queue.get(id).expect("transfer exists"))
}

async fn record_progress(
    app: &AppHandle,
    state: &AppState,
    id: TransferId,
    bytes: u64,
    started: Instant,
) -> Result<(), AppError> {
    let speed = if started.elapsed().as_secs_f64() > 0.0 {
        Some((bytes as f64 / started.elapsed().as_secs_f64()) as u64)
    } else {
        None
    };
    let mut queue = state.transfers.lock().await;
    queue.update_progress(id, bytes, speed)?;
    let job = queue.get(id).cloned().expect("transfer exists");
    state.storage.save_transfer(&job)?;
    emit(app, &progress_from_job(job));
    Ok(())
}

async fn transition(state: &AppState, id: TransferId, next: TransferState) -> Result<(), AppError> {
    let mut queue = state.transfers.lock().await;
    queue.transition(id, next)?;
    let job = queue.get(id).expect("transfer exists");
    state.storage.save_transfer(job)
}

async fn complete(app: &AppHandle, state: &AppState, id: TransferId) -> Result<(), AppError> {
    transition(state, id, TransferState::Completed).await?;
    emit_current(app, state, id).await;
    Ok(())
}

async fn fail(
    app: &AppHandle,
    state: &AppState,
    id: TransferId,
    error: AppError,
) -> Result<(), AppError> {
    let mut queue = state.transfers.lock().await;
    let current = queue.get(id).map(|job| job.state);
    if current.is_none()
        || matches!(
            current,
            Some(
                TransferState::Paused | TransferState::Cancelled | TransferState::WaitingForConflict
            )
        )
    {
        return Ok(());
    }
    queue.set_error(id, Some(error.message.clone()))?;
    if current == Some(TransferState::Running) {
        let next = if error.code == ErrorCode::ConnectionClosed {
            TransferState::WaitingForAuthentication
        } else {
            TransferState::Failed
        };
        queue.transition(id, next)?;
    }
    let job = queue.get(id).cloned().expect("transfer exists");
    state.storage.save_transfer(&job)?;
    emit(app, &progress_from_job(job));
    Ok(())
}

async fn job_snapshot(
    state: &AppState,
    id: TransferId,
) -> Result<siftlane_core::TransferJob, AppError> {
    state
        .transfers
        .lock()
        .await
        .get(id)
        .cloned()
        .ok_or_else(|| AppError::new(ErrorCode::NotFound, "Transfer not found"))
}

async fn emit_current(app: &AppHandle, state: &AppState, id: TransferId) {
    if let Ok(job) = job_snapshot(state, id).await {
        emit(app, &progress_from_job(job));
    }
}

fn emit(app: &AppHandle, progress: &TransferProgress) {
    let _ = app.emit("transfer-progress", progress);
}

fn local_io_error(source: std::io::Error) -> AppError {
    let code = match source.kind() {
        std::io::ErrorKind::NotFound => ErrorCode::NotFound,
        std::io::ErrorKind::PermissionDenied => ErrorCode::PermissionDenied,
        std::io::ErrorKind::AlreadyExists => ErrorCode::AlreadyExists,
        _ => ErrorCode::Io,
    };
    AppError::new(code, "The local file operation failed").with_detail(source.to_string())
}

fn progress_from_job(job: siftlane_core::TransferJob) -> TransferProgress {
    TransferProgress {
        id: job.id,
        state: job.state,
        bytes_transferred: job.bytes_transferred,
        bytes_total: job.bytes_total,
        speed_bytes_per_second: job.speed_bytes_per_second,
        error: job.error,
    }
}
