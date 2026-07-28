use std::{
    fs::{self, OpenOptions},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use siftlane_core::{
    AppError, AuthRef, ConnectResult, ConnectionProfile, ErrorCode, Protocol, TransferDirection,
};
use tauri::State;
use tauri_plugin_log::log;

use crate::state::AppState;

pub const LOG_FILE_STEM: &str = "siftlane-diagnostics";
pub const LOG_TARGET: &str = "siftlane_diagnostics";
pub const MAX_LOG_FILE_BYTES: u128 = 256 * 1024;
pub const RETAINED_ARCHIVED_LOG_FILES: usize = 3;

#[derive(Clone)]
pub struct Diagnostics {
    enabled: Arc<AtomicBool>,
    log_dir: PathBuf,
}

impl Diagnostics {
    pub fn new(enabled: Arc<AtomicBool>, log_dir: PathBuf) -> Self {
        Self { enabled, log_dir }
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }

    pub fn set_enabled(&self, enabled: bool) {
        if self.is_enabled() == enabled {
            return;
        }
        if enabled {
            self.enabled.store(true, Ordering::Relaxed);
            self.record("event=diagnostics_enabled");
        } else {
            self.record("event=diagnostics_disabled");
            self.enabled.store(false, Ordering::Relaxed);
        }
    }

    pub fn record_app_started(&self, version: &str) {
        if !self.is_enabled() {
            return;
        }
        log::info!(
            target: LOG_TARGET,
            "event=app_started version={} os={} arch={}",
            version,
            std::env::consts::OS,
            std::env::consts::ARCH
        );
    }

    pub fn record_connection_started(&self, profile: &ConnectionProfile) {
        if !self.is_enabled() {
            return;
        }
        log::info!(target: LOG_TARGET, "{}", connection_started_message(profile));
    }

    pub fn record_connection_finished(
        &self,
        protocol: Protocol,
        result: &Result<ConnectResult, AppError>,
    ) {
        if !self.is_enabled() {
            return;
        }
        let message = connection_finished_message(protocol, result);
        match result {
            Ok(_) => log::info!(target: LOG_TARGET, "{message}"),
            Err(_) => log::warn!(target: LOG_TARGET, "{message}"),
        }
    }

    pub fn record_session_disconnected(&self, result: &Result<(), AppError>) {
        if !self.is_enabled() {
            return;
        }
        match result {
            Ok(()) => self.record("event=session_disconnected outcome=success"),
            Err(error) => log::warn!(
                target: LOG_TARGET,
                "event=session_disconnected outcome=failed error_code={} retryable={}",
                error_code_name(error.code),
                error.retryable
            ),
        }
    }

    pub fn record_transfer_started(&self, direction: TransferDirection) {
        if !self.is_enabled() {
            return;
        }
        log::info!(
            target: LOG_TARGET,
            "event=transfer_started direction={}",
            transfer_direction_name(direction)
        );
    }

    pub fn record_transfer_retry(
        &self,
        direction: TransferDirection,
        attempt: u8,
        limit: u8,
        error: &AppError,
    ) {
        if !self.is_enabled() {
            return;
        }
        log::warn!(
            target: LOG_TARGET,
            "event=transfer_retry direction={} attempt={} limit={} error_code={}",
            transfer_direction_name(direction),
            attempt,
            limit,
            error_code_name(error.code)
        );
    }

    pub fn record_transfer_completed(&self, direction: TransferDirection, retry_count: u8) {
        if !self.is_enabled() {
            return;
        }
        log::info!(
            target: LOG_TARGET,
            "event=transfer_finished direction={} outcome=completed retries={}",
            transfer_direction_name(direction),
            retry_count
        );
    }

    pub fn record_transfer_failed(&self, direction: TransferDirection, error: &AppError) {
        if !self.is_enabled() {
            return;
        }
        log::warn!(
            target: LOG_TARGET,
            "event=transfer_finished direction={} outcome=failed error_code={} retryable={}",
            transfer_direction_name(direction),
            error_code_name(error.code),
            error.retryable
        );
    }

    pub fn record_search_started(&self, scope: SearchScope) {
        if !self.is_enabled() {
            return;
        }
        log::info!(
            target: LOG_TARGET,
            "event=search_started scope={}",
            scope.as_str()
        );
    }

    pub fn record_search_finished(&self, scope: SearchScope, error: Option<ErrorCode>) {
        if !self.is_enabled() {
            return;
        }
        match error {
            Some(code) => log::warn!(
                target: LOG_TARGET,
                "event=search_finished scope={} outcome=failed error_code={}",
                scope.as_str(),
                error_code_name(code)
            ),
            None => log::info!(
                target: LOG_TARGET,
                "event=search_finished scope={} outcome=success",
                scope.as_str()
            ),
        }
    }

    pub fn active_log_path(&self) -> PathBuf {
        self.log_dir.join(format!("{LOG_FILE_STEM}.log"))
    }

    pub fn clear_logs(&self) -> Result<(), AppError> {
        if !self.log_dir.exists() {
            return Ok(());
        }
        let entries = fs::read_dir(&self.log_dir).map_err(diagnostics_io_error)?;
        for entry in entries {
            let entry = entry.map_err(diagnostics_io_error)?;
            let path = entry.path();
            if !is_diagnostics_log(&path) {
                continue;
            }
            if path == self.active_log_path() {
                OpenOptions::new()
                    .write(true)
                    .truncate(true)
                    .open(&path)
                    .map_err(diagnostics_io_error)?;
            } else {
                fs::remove_file(path).map_err(diagnostics_io_error)?;
            }
        }
        Ok(())
    }

    fn record(&self, message: &'static str) {
        if self.is_enabled() {
            log::info!(target: LOG_TARGET, "{message}");
        }
    }
}

#[derive(Clone, Copy)]
pub enum SearchScope {
    Local,
    Remote,
}

impl SearchScope {
    fn as_str(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Remote => "remote",
        }
    }
}

fn has_custom_algorithms(profile: &ConnectionProfile) -> bool {
    let algorithms = &profile.ssh_options.algorithms;
    !algorithms.key_exchange.is_empty()
        || !algorithms.host_keys.is_empty()
        || !algorithms.ciphers.is_empty()
        || !algorithms.macs.is_empty()
}

fn connection_started_message(profile: &ConnectionProfile) -> String {
    format!(
        "event=connection_started protocol={} auth={} proxy={} proxy_jump={} custom_algorithms={}",
        protocol_name(profile.protocol),
        auth_name(&profile.auth),
        profile.ssh_options.proxy.is_some(),
        profile.ssh_options.proxy_jump_profile_id.is_some(),
        has_custom_algorithms(profile),
    )
}

fn connection_finished_message(
    protocol: Protocol,
    result: &Result<ConnectResult, AppError>,
) -> String {
    match result {
        Ok(ConnectResult::Connected { .. }) => format!(
            "event=connection_finished protocol={} outcome=connected",
            protocol_name(protocol)
        ),
        Ok(ConnectResult::NeedsHostTrust { challenge }) => format!(
            "event=connection_finished protocol={} outcome=host_trust_required changed_key={}",
            protocol_name(protocol),
            challenge.changed
        ),
        Ok(ConnectResult::NeedsCredential { .. }) => format!(
            "event=connection_finished protocol={} outcome=credential_required",
            protocol_name(protocol)
        ),
        Err(error) => format!(
            "event=connection_finished protocol={} outcome=failed error_code={} retryable={}",
            protocol_name(protocol),
            error_code_name(error.code),
            error.retryable
        ),
    }
}

fn protocol_name(protocol: Protocol) -> &'static str {
    match protocol {
        Protocol::Sftp => "sftp",
        Protocol::Ftp => "ftp",
        Protocol::Ftps => "ftps",
    }
}

fn auth_name(auth: &AuthRef) -> &'static str {
    match auth {
        AuthRef::Anonymous => "anonymous",
        AuthRef::Password { .. } => "password",
        AuthRef::PrivateKey { .. } => "private_key",
        AuthRef::Agent => "agent",
    }
}

fn transfer_direction_name(direction: TransferDirection) -> &'static str {
    match direction {
        TransferDirection::Upload => "upload",
        TransferDirection::Download => "download",
        TransferDirection::RemoteToRemote => "remote_to_remote",
    }
}

fn error_code_name(code: ErrorCode) -> &'static str {
    match code {
        ErrorCode::InvalidInput => "invalid_input",
        ErrorCode::NotFound => "not_found",
        ErrorCode::AlreadyExists => "already_exists",
        ErrorCode::PermissionDenied => "permission_denied",
        ErrorCode::AuthenticationFailed => "authentication_failed",
        ErrorCode::HostKeyUnknown => "host_key_unknown",
        ErrorCode::HostKeyChanged => "host_key_changed",
        ErrorCode::ConnectionFailed => "connection_failed",
        ErrorCode::ConnectionClosed => "connection_closed",
        ErrorCode::TimedOut => "timed_out",
        ErrorCode::Conflict => "conflict",
        ErrorCode::Unsupported => "unsupported",
        ErrorCode::SecretStoreUnavailable => "secret_store_unavailable",
        ErrorCode::Storage => "storage",
        ErrorCode::Io => "io",
        ErrorCode::Internal => "internal",
    }
}

fn is_diagnostics_log(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with(LOG_FILE_STEM) && name.ends_with(".log"))
}

fn diagnostics_io_error(source: std::io::Error) -> AppError {
    AppError::new(ErrorCode::Io, "Could not manage the diagnostic logs")
        .with_detail(source.to_string())
}

#[tauri::command]
pub fn get_diagnostics_log_path(state: State<'_, AppState>) -> PathBuf {
    state.diagnostics.active_log_path()
}

#[tauri::command]
pub fn clear_diagnostic_logs(state: State<'_, AppState>) -> Result<(), AppError> {
    state.diagnostics.clear_logs()
}

#[cfg(test)]
mod tests {
    use super::*;
    use siftlane_core::{SshAlgorithmPolicy, SshOptions, SshProxy, SshProxyKind};

    #[test]
    fn diagnostics_log_matching_does_not_touch_other_logs() {
        assert!(is_diagnostics_log(Path::new("siftlane-diagnostics.log")));
        assert!(is_diagnostics_log(Path::new(
            "siftlane-diagnostics_2026-07-28_12-00-00.log"
        )));
        assert!(!is_diagnostics_log(Path::new("siftlane.log")));
        assert!(!is_diagnostics_log(Path::new("siftlane-diagnostics.txt")));
    }

    #[test]
    fn clearing_logs_only_removes_diagnostics_files() {
        let directory = tempfile::tempdir().unwrap();
        let active = directory.path().join("siftlane-diagnostics.log");
        let archived = directory
            .path()
            .join("siftlane-diagnostics_2026-07-28_12-00-00.log");
        let unrelated = directory.path().join("other.log");
        fs::write(&active, "active secret").unwrap();
        fs::write(&archived, "archived secret").unwrap();
        fs::write(&unrelated, "keep").unwrap();

        let diagnostics =
            Diagnostics::new(Arc::new(AtomicBool::new(false)), directory.path().into());
        diagnostics.clear_logs().unwrap();

        assert_eq!(fs::read_to_string(active).unwrap(), "");
        assert!(!archived.exists());
        assert_eq!(fs::read_to_string(unrelated).unwrap(), "keep");
    }

    #[test]
    fn connection_events_exclude_user_and_secret_values() {
        let mut profile = ConnectionProfile::new(
            "SECRET_LABEL".into(),
            "SECRET_HOST".into(),
            "SECRET_USERNAME".into(),
            AuthRef::PrivateKey {
                path: "SECRET_KEY_PATH".into(),
                remember_passphrase: true,
            },
        );
        profile.notes = "SECRET_NOTES".into();
        profile.initial_remote_path = "/SECRET_REMOTE_PATH".into();
        profile.ssh_options = SshOptions {
            proxy_jump_profile_id: Some(uuid::Uuid::new_v4()),
            proxy: Some(SshProxy {
                kind: SshProxyKind::Socks5,
                host: "SECRET_PROXY_HOST".into(),
                port: 1080,
            }),
            algorithms: SshAlgorithmPolicy {
                key_exchange: vec!["SECRET_ALGORITHM".into()],
                ..Default::default()
            },
            ..Default::default()
        };

        let started = connection_started_message(&profile);
        let failed = connection_finished_message(
            Protocol::Sftp,
            &Err(
                AppError::new(ErrorCode::AuthenticationFailed, "SECRET_ERROR_MESSAGE")
                    .with_detail("SECRET_ERROR_DETAIL"),
            ),
        );
        let output = format!("{started}\n{failed}");

        for secret in [
            "SECRET_LABEL",
            "SECRET_HOST",
            "SECRET_USERNAME",
            "SECRET_KEY_PATH",
            "SECRET_NOTES",
            "SECRET_REMOTE_PATH",
            "SECRET_PROXY_HOST",
            "SECRET_ALGORITHM",
            "SECRET_ERROR_MESSAGE",
            "SECRET_ERROR_DETAIL",
        ] {
            assert!(!output.contains(secret));
        }
        assert!(output.contains("protocol=sftp"));
        assert!(output.contains("auth=private_key"));
        assert!(output.contains("error_code=authentication_failed"));
    }
}
