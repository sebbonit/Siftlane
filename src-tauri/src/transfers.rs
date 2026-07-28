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

const CHUNK_SIZE: usize = 4 * 1024 * 1024;
const MIN_THROTTLED_CHUNK_SIZE: usize = 1024;
const THROTTLE_CHECKS_PER_SECOND: u64 = 4;
const THROTTLE_STATE_CHECK_INTERVAL: Duration = Duration::from_millis(250);
const MAX_SHA256_VERIFICATION_BYTES: u64 = 64 * 1024 * 1024;
const PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(100);
const PROGRESS_PERSIST_INTERVAL: Duration = Duration::from_secs(1);

struct ProgressCadence {
    last_emit: Instant,
    last_persist: Instant,
}

impl ProgressCadence {
    fn new() -> Self {
        let now = Instant::now();
        Self {
            last_emit: now - PROGRESS_EMIT_INTERVAL,
            last_persist: now - PROGRESS_PERSIST_INTERVAL,
        }
    }
}

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
                        Ok(job) => (job.source_profile_id, job.profile_id),
                        Err(_) => break,
                    };
                    for reconnect_id in [profile_id.0, Some(profile_id.1)].into_iter().flatten() {
                        if let Err(reconnect_error) =
                            crate::commands::reconnect_profile_for_transfer(
                                &app,
                                &state,
                                reconnect_id,
                            )
                            .await
                            && !reconnect_error.retryable
                        {
                            let _ = fail(&app, &state, id, reconnect_error).await;
                            return;
                        }
                    }
                }
            }
        }
    });
}

async fn run(app: AppHandle, state: AppState, id: TransferId) -> Result<(), AppError> {
    let queued_job = job_snapshot(&state, id).await?;
    state
        .diagnostics
        .record_transfer_started(queued_job.direction);
    let profile = state.storage.get_profile(queued_job.profile_id)?;
    let destination_endpoint = format!(
        "{:?}://{}:{}",
        profile.protocol,
        profile.host.to_lowercase(),
        profile.port
    );
    let endpoint = if let Some(source_profile_id) = queued_job.source_profile_id {
        let source = state.storage.get_profile(source_profile_id)?;
        format!(
            "{:?}://{}:{} -> {destination_endpoint}",
            source.protocol,
            source.host.to_lowercase(),
            source.port
        )
    } else {
        destination_endpoint
    };
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
        queue.get(id).cloned().expect("transfer exists")
    };
    persist_transfer(&state, &job).await?;
    emit(&app, &progress_from_job(job.clone()));

    match job.direction {
        TransferDirection::Upload => {
            let remote = session_client(&state, job.destination_session_id, job.profile_id).await?;
            upload(&app, &state, remote, id).await
        }
        TransferDirection::Download => {
            let remote = session_client(&state, job.source_session_id, job.profile_id).await?;
            download(&app, &state, remote, id).await
        }
        TransferDirection::RemoteToRemote => {
            let source_profile_id = job
                .source_profile_id
                .ok_or_else(|| AppError::new(ErrorCode::Internal, "The source route is missing"))?;
            let source = session_client(&state, job.source_session_id, source_profile_id).await?;
            let destination =
                session_client(&state, job.destination_session_id, job.profile_id).await?;
            remote_to_remote(&app, &state, source, destination, id).await
        }
    }
}

async fn session_client(
    state: &AppState,
    session_id: Option<uuid::Uuid>,
    profile_id: uuid::Uuid,
) -> Result<Arc<dyn RemoteFilesystem>, AppError> {
    let sessions = state.sessions.read().await;
    session_id
        .and_then(|id| sessions.get(&id))
        .or_else(|| {
            sessions
                .values()
                .find(|session| session.profile_id == profile_id)
        })
        .map(|session| session.client.clone())
        .ok_or_else(|| {
            AppError::new(
                ErrorCode::ConnectionClosed,
                "Reconnect both routed sessions before resuming this transfer",
            )
        })
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
    let limit = state.preferences.read().await.automatic_retry_limit;
    let (updated, delay_seconds) = {
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
        (queue.get(id)?.clone(), delay_seconds)
    };
    persist_transfer(state, &updated).await.ok()?;
    state
        .diagnostics
        .record_transfer_retry(updated.direction, updated.retry_count, limit, error);
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
    let mut cadence = ProgressCadence::new();
    while offset < source_metadata.len() {
        ensure_running(state, id).await?;
        let limits = transfer_limits(state, &job).await;
        let request_size = transfer_chunk_size(limits).min(buffer.len());
        let count = source
            .read(&mut buffer[..request_size])
            .await
            .map_err(local_io_error)?;
        if count == 0 {
            break;
        }
        throttle(state, &job, id, count, limits).await?;
        remote
            .write_chunk(&job.partial_path, offset, &buffer[..count])
            .await?;
        offset += count as u64;
        record_progress(app, state, id, offset, partial_size, started, &mut cadence).await?;
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
    let starting_offset = offset;
    let mut cadence = ProgressCadence::new();
    while offset < total {
        ensure_running(state, id).await?;
        let limits = transfer_limits(state, &job).await;
        let remaining = (total - offset).min(transfer_chunk_size(limits) as u64) as u32;
        throttle(state, &job, id, remaining as usize, limits).await?;
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
        record_progress(
            app,
            state,
            id,
            offset,
            starting_offset,
            started,
            &mut cadence,
        )
        .await?;
    }
    destination.flush().await.map_err(local_io_error)?;
    destination.sync_all().await.map_err(local_io_error)?;
    drop(destination);
    verify_download(state, remote.as_ref(), id, total).await?;
    commit_local(state, id).await?;
    preserve_download_metadata(state, &source, id).await?;
    complete(app, state, id).await
}

async fn remote_to_remote(
    app: &AppHandle,
    state: &AppState,
    source: Arc<dyn RemoteFilesystem>,
    destination: Arc<dyn RemoteFilesystem>,
    id: TransferId,
) -> Result<(), AppError> {
    let job = job_snapshot(state, id).await?;
    let metadata = source
        .metadata(&job.source_path)
        .await?
        .ok_or_else(|| AppError::new(ErrorCode::NotFound, "The remote source no longer exists"))?;
    let total = metadata.size.ok_or_else(|| {
        AppError::new(
            ErrorCode::Unsupported,
            "The source server did not report a file size",
        )
    })?;
    set_total(state, id, total).await?;
    if handle_remote_conflict(state, destination.as_ref(), id).await? {
        emit_current(app, state, id).await;
        return Ok(());
    }
    let job = job_snapshot(state, id).await?;
    let mut offset = destination
        .metadata(&job.partial_path)
        .await?
        .and_then(|entry| entry.size)
        .unwrap_or(0)
        .min(total);
    let started = Instant::now();
    let starting_offset = offset;
    let mut cadence = ProgressCadence::new();
    while offset < total {
        ensure_running(state, id).await?;
        let limits = transfer_limits(state, &job).await;
        let requested = (total - offset).min(transfer_chunk_size(limits) as u64) as u32;
        throttle(state, &job, id, requested as usize, limits).await?;
        let bytes = source
            .read_chunk(&job.source_path, offset, requested)
            .await?;
        if bytes.is_empty() || bytes.len() > requested as usize {
            return Err(AppError::new(
                ErrorCode::Io,
                "The source returned an invalid streaming chunk",
            ));
        }
        destination
            .write_chunk(&job.partial_path, offset, &bytes)
            .await?;
        offset += bytes.len() as u64;
        record_progress(
            app,
            state,
            id,
            offset,
            starting_offset,
            started,
            &mut cadence,
        )
        .await?;
    }
    destination.sync_file(&job.partial_path).await?;
    let destination_size = destination
        .metadata(&job.partial_path)
        .await?
        .and_then(|entry| entry.size);
    if destination_size != Some(total) {
        return Err(verification_error(total, destination_size));
    }
    let verification = if total <= MAX_SHA256_VERIFICATION_BYTES {
        let (source_hash, destination_hash) = tokio::try_join!(
            hash_remote_file(source.as_ref(), &job.source_path, total),
            hash_remote_file(destination.as_ref(), &job.partial_path, total)
        )?;
        if source_hash != destination_hash {
            return Err(AppError::new(
                ErrorCode::Conflict,
                "SHA-256 verification failed; the destination partial file was retained",
            ));
        }
        TransferVerification::Sha256Verified
    } else {
        TransferVerification::SizeVerified
    };
    set_verification(state, id, verification).await?;
    commit_remote(state, destination.as_ref(), id).await?;
    if job.preserve_permissions
        && destination.capabilities().chmod
        && let Some(permissions) = metadata.permissions
    {
        destination
            .set_permissions(&job.destination_path, permissions)
            .await?;
    }
    complete(app, state, id).await
}

async fn transfer_limits(
    state: &AppState,
    job: &siftlane_core::TransferJob,
) -> (Option<u64>, Option<u64>) {
    let preferences = state.preferences.read().await;
    let (global, profile) = bandwidth_limits(&preferences, job);
    (global, profile)
}

fn transfer_chunk_size((global, profile): (Option<u64>, Option<u64>)) -> usize {
    let Some(limit) = strictest_limit(global, profile).filter(|limit| *limit > 0) else {
        return CHUNK_SIZE;
    };
    usize::try_from(limit / THROTTLE_CHECKS_PER_SECOND)
        .unwrap_or(CHUNK_SIZE)
        .clamp(MIN_THROTTLED_CHUNK_SIZE, CHUNK_SIZE)
}

async fn throttle(
    state: &AppState,
    job: &siftlane_core::TransferJob,
    id: TransferId,
    bytes: usize,
    (global, profile): (Option<u64>, Option<u64>),
) -> Result<(), AppError> {
    let acquisition = state.bandwidth_limiter.acquire(
        match job.direction {
            TransferDirection::Upload => "upload",
            TransferDirection::Download => "download",
            TransferDirection::RemoteToRemote => "remote",
        },
        job.profile_id,
        bytes,
        global,
        profile,
    );
    tokio::pin!(acquisition);
    loop {
        tokio::select! {
            () = &mut acquisition => return ensure_running(state, id).await,
            () = tokio::time::sleep(THROTTLE_STATE_CHECK_INTERVAL) => {
                ensure_running(state, id).await?;
            }
        }
    }
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
            TransferDirection::RemoteToRemote => {
                strictest_limit(limit.upload_bps, limit.download_bps)
            }
        }
    } else if let Some(schedule) = scheduled {
        match job.direction {
            TransferDirection::Upload => schedule.upload_bps,
            TransferDirection::Download => schedule.download_bps,
            TransferDirection::RemoteToRemote => {
                strictest_limit(schedule.upload_bps, schedule.download_bps)
            }
        }
    } else {
        match job.direction {
            TransferDirection::Upload => preferences.global_upload_limit_bps,
            TransferDirection::Download => preferences.global_download_limit_bps,
            TransferDirection::RemoteToRemote => strictest_limit(
                preferences.global_upload_limit_bps,
                preferences.global_download_limit_bps,
            ),
        }
    };
    let profile = preferences
        .profile_bandwidth_limits
        .get(&job.profile_id.to_string())
        .and_then(|limit| match job.direction {
            TransferDirection::Upload => limit.upload_bps,
            TransferDirection::Download => limit.download_bps,
            TransferDirection::RemoteToRemote => {
                strictest_limit(limit.upload_bps, limit.download_bps)
            }
        });
    (global, profile)
}

fn strictest_limit(first: Option<u64>, second: Option<u64>) -> Option<u64> {
    let first = first.filter(|limit| *limit > 0);
    let second = second.filter(|limit| *limit > 0);
    match (first, second) {
        (Some(first), Some(second)) => Some(first.min(second)),
        (Some(limit), None) | (None, Some(limit)) => Some(limit),
        (None, None) => None,
    }
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
    let job = {
        let mut queue = state.transfers.lock().await;
        queue.update_total(id, total)?;
        queue.get(id).cloned().expect("transfer exists")
    };
    persist_transfer(state, &job).await
}

async fn record_progress(
    app: &AppHandle,
    state: &AppState,
    id: TransferId,
    bytes: u64,
    starting_offset: u64,
    started: Instant,
    cadence: &mut ProgressCadence,
) -> Result<(), AppError> {
    let speed = average_speed(bytes, starting_offset, started.elapsed());
    let now = Instant::now();
    let should_emit = now.duration_since(cadence.last_emit) >= PROGRESS_EMIT_INTERVAL;
    let should_persist = now.duration_since(cadence.last_persist) >= PROGRESS_PERSIST_INTERVAL;
    let job = {
        let mut queue = state.transfers.lock().await;
        queue.update_progress(id, bytes, speed)?;
        queue.get(id).cloned().expect("transfer exists")
    };
    if should_persist {
        persist_transfer(state, &job).await?;
        cadence.last_persist = now;
    }
    if should_emit {
        emit(app, &progress_from_job(job));
        cadence.last_emit = now;
    }
    Ok(())
}

async fn transition(state: &AppState, id: TransferId, next: TransferState) -> Result<(), AppError> {
    let job = {
        let mut queue = state.transfers.lock().await;
        queue.transition(id, next)?;
        queue.get(id).cloned().expect("transfer exists")
    };
    persist_transfer(state, &job).await
}

async fn complete(app: &AppHandle, state: &AppState, id: TransferId) -> Result<(), AppError> {
    transition(state, id, TransferState::Completed).await?;
    let job = job_snapshot(state, id).await?;
    state
        .diagnostics
        .record_transfer_completed(job.direction, job.retry_count);
    emit_current(app, state, id).await;
    Ok(())
}

async fn fail(
    app: &AppHandle,
    state: &AppState,
    id: TransferId,
    error: AppError,
) -> Result<(), AppError> {
    let job = {
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
        queue.get(id).cloned().expect("transfer exists")
    };
    state
        .diagnostics
        .record_transfer_failed(job.direction, &error);
    persist_transfer(state, &job).await?;
    emit(app, &progress_from_job(job));
    Ok(())
}

fn average_speed(bytes: u64, starting_offset: u64, elapsed: Duration) -> Option<u64> {
    let seconds = elapsed.as_secs_f64();
    (seconds > 0.0).then(|| ((bytes.saturating_sub(starting_offset)) as f64 / seconds) as u64)
}

async fn persist_transfer(
    state: &AppState,
    job: &siftlane_core::TransferJob,
) -> Result<(), AppError> {
    let storage = state.storage.clone();
    let job = job.clone();
    tokio::task::spawn_blocking(move || storage.save_transfer(&job))
        .await
        .map_err(|error| {
            AppError::new(
                ErrorCode::Internal,
                "The transfer persistence task could not finish",
            )
            .with_detail(error.to_string())
        })?
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

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::{CHUNK_SIZE, average_speed, strictest_limit, transfer_chunk_size};

    #[test]
    fn remote_stream_uses_the_strictest_configured_rate() {
        assert_eq!(strictest_limit(Some(4_000), Some(2_000)), Some(2_000));
        assert_eq!(strictest_limit(Some(4_000), None), Some(4_000));
        assert_eq!(strictest_limit(Some(0), Some(4_000)), Some(4_000));
        assert_eq!(strictest_limit(None, None), None);
    }

    #[test]
    fn throttled_chunks_keep_control_checks_responsive() {
        assert_eq!(transfer_chunk_size((None, None)), CHUNK_SIZE);
        assert_eq!(transfer_chunk_size((Some(64 * 1024), None)), 16 * 1024);
        assert_eq!(
            transfer_chunk_size((Some(1024 * 1024), Some(32 * 1024))),
            8 * 1024
        );
        assert_eq!(transfer_chunk_size((Some(1024), None)), 1024);
    }

    #[test]
    fn resumed_speed_only_counts_bytes_moved_in_this_run() {
        assert_eq!(
            average_speed(12 * 1024, 10 * 1024, Duration::from_secs(2)),
            Some(1024)
        );
    }
}
