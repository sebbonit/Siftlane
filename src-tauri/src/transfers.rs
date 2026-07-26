use std::{
    path::Path,
    sync::Arc,
    time::{Duration, Instant},
};

use chrono::{Datelike, Local, Timelike};
use sha2::{Digest, Sha256};
use siftlane_core::{
    AppError, ConflictPolicy, ErrorCode, Preferences, RemoteFilesystem, TransferDirection,
    TransferId, TransferProgress, TransferState, TransferVerification,
};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

use crate::state::AppState;

const CHUNK_SIZE: usize = 256 * 1024;
const MAX_SHA256_VERIFICATION_BYTES: u64 = 64 * 1024 * 1024;

pub fn spawn(app: AppHandle, state: AppState, id: TransferId) {
    tauri::async_runtime::spawn(async move {
        loop {
            match run(app.clone(), state.clone(), id).await {
                Ok(()) => break,
                Err(error) => {
                    let Some(delay) = prepare_retry(&app, &state, id, &error).await else {
                        let _ = fail(&app, &state, id, error).await;
                        break;
                    };
                    tokio::time::sleep(delay).await;
                    let profile_id = match job_snapshot(&state, id).await {
                        Ok(job) => job.profile_id,
                        Err(_) => break,
                    };
                    if let Err(reconnect_error) =
                        crate::commands::reconnect_profile_for_transfer(&app, &state, profile_id)
                            .await
                        && !reconnect_error.retryable
                    {
                        let _ = fail(&app, &state, id, reconnect_error).await;
                        break;
                    }
                }
            }
        }
    });
}

async fn run(app: AppHandle, state: AppState, id: TransferId) -> Result<(), AppError> {
    let queued_job = job_snapshot(&state, id).await?;
    let profile = state.storage.get_profile(queued_job.profile_id)?;
    let endpoint = format!(
        "{:?}://{}:{}",
        profile.protocol,
        profile.host.to_lowercase(),
        profile.port
    );
    let _permit = state.transfer_scheduler.acquire(id, endpoint).await;
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
            queue.set_error(id, None)?;
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

async fn prepare_retry(
    app: &AppHandle,
    state: &AppState,
    id: TransferId,
    error: &AppError,
) -> Option<Duration> {
    if !error.retryable {
        return None;
    }
    let limit = state.storage.load_preferences().ok()?.automatic_retry_limit;
    let mut queue = state.transfers.lock().await;
    let job = queue.get(id)?.clone();
    if job.state != TransferState::Running || job.retry_count >= limit {
        return None;
    }
    let attempt = job.retry_count.saturating_add(1);
    let delay_seconds = 2_u64
        .saturating_pow(u32::from(attempt.saturating_sub(1)))
        .min(30);
    queue.transition(id, TransferState::Interrupted).ok()?;
    queue.increment_retry(id).ok()?;
    queue.record_retry(id, error.message.clone()).ok()?;
    queue
        .set_error(
            id,
            Some(format!(
                "{} Retrying in {delay_seconds}s ({attempt}/{limit}).",
                error.message
            )),
        )
        .ok()?;
    let updated = queue.get(id)?.clone();
    state.storage.save_transfer(&updated).ok()?;
    emit(app, &progress_from_job(updated));
    Some(Duration::from_secs(delay_seconds))
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
    let job = job_snapshot(state, id).await?;

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
        throttle(state, &job, count).await;
        remote
            .write_chunk(&job.partial_path, offset, &buffer[..count])
            .await?;
        offset += count as u64;
        record_progress(app, state, id, offset, started).await?;
    }
    remote.sync_file(&job.partial_path).await?;
    verify_upload(state, remote.as_ref(), id, source_metadata.len()).await?;
    commit_remote(state, remote.as_ref(), id).await?;
    preserve_upload_metadata(state, remote.as_ref(), id).await?;
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
    let job = job_snapshot(state, id).await?;
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
        throttle(state, &job, remaining as usize).await;
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
    verify_download(state, remote.as_ref(), id, total).await?;
    commit_local(state, id).await?;
    preserve_download_metadata(state, &source, id).await?;
    complete(app, state, id).await
}

async fn throttle(state: &AppState, job: &siftlane_core::TransferJob, bytes: usize) {
    let Ok(preferences) = state.storage.load_preferences() else {
        return;
    };
    let (global, profile) = bandwidth_limits(&preferences, job);
    state
        .bandwidth_limiter
        .acquire(
            match job.direction {
                TransferDirection::Upload => "upload",
                TransferDirection::Download => "download",
            },
            job.profile_id,
            bytes,
            global,
            profile,
        )
        .await;
}

fn bandwidth_limits(
    preferences: &Preferences,
    job: &siftlane_core::TransferJob,
) -> (Option<u64>, Option<u64>) {
    let now = chrono::Utc::now();
    let temporary = preferences
        .temporary_bandwidth_limit
        .as_ref()
        .filter(|limit| limit.expires_at > now);
    let scheduled = active_schedule(preferences);
    let global = if let Some(limit) = temporary {
        match job.direction {
            TransferDirection::Upload => limit.upload_bps,
            TransferDirection::Download => limit.download_bps,
        }
    } else if let Some(schedule) = scheduled {
        match job.direction {
            TransferDirection::Upload => schedule.upload_bps,
            TransferDirection::Download => schedule.download_bps,
        }
    } else {
        match job.direction {
            TransferDirection::Upload => preferences.global_upload_limit_bps,
            TransferDirection::Download => preferences.global_download_limit_bps,
        }
    };
    let profile = preferences
        .profile_bandwidth_limits
        .get(&job.profile_id.to_string())
        .and_then(|limit| match job.direction {
            TransferDirection::Upload => limit.upload_bps,
            TransferDirection::Download => limit.download_bps,
        });
    (global, profile)
}

fn active_schedule(preferences: &Preferences) -> Option<&siftlane_core::BandwidthSchedule> {
    let now = Local::now();
    let day = now.weekday().num_days_from_monday() as u8;
    let minute = now.hour() * 60 + now.minute();
    preferences.bandwidth_schedules.iter().find(|schedule| {
        if !schedule.enabled || (!schedule.days.is_empty() && !schedule.days.contains(&day)) {
            return false;
        }
        let parse = |value: &str| {
            let (hour, minute) = value.split_once(':')?;
            Some(hour.parse::<u32>().ok()? * 60 + minute.parse::<u32>().ok()?)
        };
        let (Some(start), Some(end)) = (parse(&schedule.start_time), parse(&schedule.end_time))
        else {
            return false;
        };
        if start <= end {
            minute >= start && minute < end
        } else {
            minute >= start || minute < end
        }
    })
}

async fn preserve_upload_metadata(
    state: &AppState,
    remote: &dyn RemoteFilesystem,
    id: TransferId,
) -> Result<(), AppError> {
    let job = job_snapshot(state, id).await?;
    if !job.preserve_permissions || !remote.capabilities().chmod {
        return Ok(());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let metadata = tokio::fs::metadata(&job.source_path)
            .await
            .map_err(local_io_error)?;
        remote
            .set_permissions(&job.destination_path, metadata.permissions().mode())
            .await?;
    }
    Ok(())
}

async fn preserve_download_metadata(
    state: &AppState,
    source: &siftlane_core::FileEntry,
    id: TransferId,
) -> Result<(), AppError> {
    let job = job_snapshot(state, id).await?;
    #[cfg(unix)]
    if job.preserve_permissions
        && let Some(mode) = source.permissions
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(&job.destination_path, std::fs::Permissions::from_mode(mode))
            .await
            .map_err(local_io_error)?;
    }
    if job.preserve_modified_time
        && let Some(modified) = source.modified_at
    {
        let path = job.destination_path.clone();
        tokio::task::spawn_blocking(move || {
            let file = std::fs::OpenOptions::new().write(true).open(path)?;
            file.set_times(std::fs::FileTimes::new().set_modified(modified.into()))
        })
        .await
        .map_err(|error| {
            AppError::new(ErrorCode::Internal, "Metadata preservation task failed")
                .with_detail(error.to_string())
        })?
        .map_err(local_io_error)?;
    }
    Ok(())
}

async fn verify_upload(
    state: &AppState,
    remote: &dyn RemoteFilesystem,
    id: TransferId,
    expected_size: u64,
) -> Result<(), AppError> {
    let job = job_snapshot(state, id).await?;
    let remote_size = remote
        .metadata(&job.partial_path)
        .await?
        .and_then(|entry| entry.size);
    if remote_size != Some(expected_size) {
        return Err(verification_error(expected_size, remote_size));
    }
    let verification = if expected_size <= MAX_SHA256_VERIFICATION_BYTES {
        let (local_hash, remote_hash) = tokio::try_join!(
            hash_local_file(&job.source_path),
            hash_remote_file(remote, &job.partial_path, expected_size)
        )?;
        if local_hash != remote_hash {
            return Err(AppError::new(
                ErrorCode::Conflict,
                "SHA-256 verification failed; the uploaded partial file was retained",
            ));
        }
        TransferVerification::Sha256Verified
    } else {
        TransferVerification::SizeVerified
    };
    set_verification(state, id, verification).await
}

async fn verify_download(
    state: &AppState,
    remote: &dyn RemoteFilesystem,
    id: TransferId,
    expected_size: u64,
) -> Result<(), AppError> {
    let job = job_snapshot(state, id).await?;
    let local_size = tokio::fs::metadata(&job.partial_path)
        .await
        .map_err(local_io_error)?
        .len();
    let remote_size = remote
        .metadata(&job.source_path)
        .await?
        .and_then(|entry| entry.size);
    if local_size != expected_size || remote_size != Some(expected_size) {
        return Err(verification_error(expected_size, remote_size));
    }
    let verification = if expected_size <= MAX_SHA256_VERIFICATION_BYTES {
        let (local_hash, remote_hash) = tokio::try_join!(
            hash_local_file(&job.partial_path),
            hash_remote_file(remote, &job.source_path, expected_size)
        )?;
        if local_hash != remote_hash {
            return Err(AppError::new(
                ErrorCode::Conflict,
                "SHA-256 verification failed; the downloaded partial file was retained",
            ));
        }
        TransferVerification::Sha256Verified
    } else {
        TransferVerification::SizeVerified
    };
    set_verification(state, id, verification).await
}

async fn hash_local_file(path: &str) -> Result<[u8; 32], AppError> {
    let mut file = tokio::fs::File::open(path).await.map_err(local_io_error)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0; CHUNK_SIZE];
    loop {
        let count = file.read(&mut buffer).await.map_err(local_io_error)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(hasher.finalize().into())
}

async fn hash_remote_file(
    remote: &dyn RemoteFilesystem,
    path: &str,
    expected_size: u64,
) -> Result<[u8; 32], AppError> {
    let mut hasher = Sha256::new();
    let mut offset = 0;
    while offset < expected_size {
        let remaining = (expected_size - offset).min(CHUNK_SIZE as u64) as u32;
        let bytes = remote.read_chunk(path, offset, remaining).await?;
        if bytes.is_empty() {
            return Err(AppError::new(
                ErrorCode::Io,
                "The remote file ended during integrity verification",
            ));
        }
        offset += bytes.len() as u64;
        hasher.update(bytes);
    }
    Ok(hasher.finalize().into())
}

fn verification_error(expected_size: u64, actual_size: Option<u64>) -> AppError {
    AppError::new(
        ErrorCode::Conflict,
        "Size verification failed; the partial file was retained",
    )
    .with_detail(format!(
        "Expected {expected_size} bytes, found {}",
        actual_size
            .map(|size| size.to_string())
            .unwrap_or_else(|| "an unknown size".into())
    ))
}

async fn set_verification(
    state: &AppState,
    id: TransferId,
    verification: TransferVerification,
) -> Result<(), AppError> {
    let mut queue = state.transfers.lock().await;
    queue.set_verification(id, verification)?;
    state
        .storage
        .save_transfer(queue.get(id).expect("transfer exists"))
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
        ConflictPolicy::Rename => {
            let destination =
                next_available_remote_destination(remote, &job.destination_path).await?;
            update_destination(state, id, destination).await?;
            Ok(false)
        }
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
        ConflictPolicy::Rename => {
            let destination = next_available_local_destination(&job.destination_path).await?;
            update_destination(state, id, destination).await?;
            Ok(false)
        }
    }
}

async fn next_available_remote_destination(
    remote: &dyn RemoteFilesystem,
    destination: &str,
) -> Result<String, AppError> {
    for index in 2..=10_000 {
        let candidate = numbered_destination(destination, index);
        if remote.metadata(&candidate).await?.is_none() {
            return Ok(candidate);
        }
    }
    Err(AppError::new(
        ErrorCode::Conflict,
        "Could not find an available destination name",
    ))
}

async fn next_available_local_destination(destination: &str) -> Result<String, AppError> {
    for index in 2..=10_000 {
        let candidate = numbered_destination(destination, index);
        if !tokio::fs::try_exists(&candidate)
            .await
            .map_err(local_io_error)?
        {
            return Ok(candidate);
        }
    }
    Err(AppError::new(
        ErrorCode::Conflict,
        "Could not find an available destination name",
    ))
}

fn numbered_destination(destination: &str, index: usize) -> String {
    let separator = destination
        .rfind(['/', '\\'])
        .map_or(0, |position| position + 1);
    let (parent, name) = destination.split_at(separator);
    let extension = name
        .rfind('.')
        .filter(|position| *position > 0)
        .unwrap_or(name.len());
    let (stem, suffix) = name.split_at(extension);
    format!("{parent}{stem} ({index}){suffix}")
}

async fn update_destination(
    state: &AppState,
    id: TransferId,
    destination: String,
) -> Result<(), AppError> {
    let mut queue = state.transfers.lock().await;
    queue.update_destination(id, destination)?;
    state
        .storage
        .save_transfer(queue.get(id).expect("transfer exists"))
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
                TransferState::Paused
                    | TransferState::Cancelled
                    | TransferState::WaitingForConflict
            )
        )
    {
        return Ok(());
    }
    queue.set_error(id, Some(error.message.clone()))?;
    if matches!(
        current,
        Some(TransferState::Running | TransferState::Interrupted)
    ) {
        let next = if matches!(
            error.code,
            ErrorCode::ConnectionClosed | ErrorCode::AuthenticationFailed
        ) {
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
        retry_count: job.retry_count,
        verification: job.verification,
        error: job.error,
    }
}
