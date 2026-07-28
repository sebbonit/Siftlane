use std::{
    fs::{self, OpenOptions},
    io,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

use chrono::NaiveDateTime;
use siftlane_core::{
    AppError, AuthRef, ConnectResult, ConnectionProfile, ErrorCode, Protocol, TransferDirection,
};
use tauri::{Manager, Runtime, State, plugin::TauriPlugin};
use tauri_plugin_log::log;

use crate::state::AppState;

pub const LOG_FILE_STEM: &str = "siftlane-diagnostics";
pub const MAX_LOG_FILE_BYTES: u128 = 256 * 1024;
pub const RETAINED_ARCHIVED_LOG_FILES: usize = 2;
const LOG_TARGET: &str = "siftlane_diagnostics";
const ACTIVE_LOG_FILE_NAME: &str = "siftlane-diagnostics.log";
const LEGACY_UNFILTERED_LOG_FILE_NAME: &str = "siftlane.log";

pub fn log_metadata_allowed(metadata: &log::Metadata<'_>, enabled: &AtomicBool) -> bool {
    enabled.load(Ordering::Relaxed) && metadata.target() == LOG_TARGET
}

#[derive(Clone)]
pub struct Diagnostics {
    enabled: Arc<AtomicBool>,
    log_dir: PathBuf,
    maintenance: Arc<Mutex<()>>,
}

impl Diagnostics {
    pub fn new(enabled: Arc<AtomicBool>, log_dir: PathBuf) -> Self {
        Self {
            enabled,
            log_dir,
            maintenance: Arc::new(Mutex::new(())),
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }

    pub fn set_enabled(&self, enabled: bool) {
        let _maintenance = self
            .maintenance
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
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

    pub fn record_app_started(&self) {
        if !self.is_enabled() {
            return;
        }
        log::info!(
            target: LOG_TARGET,
            "event=app_started version={} os={} arch={}",
            env!("CARGO_PKG_VERSION"),
            std::env::consts::OS,
            std::env::consts::ARCH
        );
    }

    pub fn record_connection_started(&self, connection: DiagnosticConnection) {
        if !self.is_enabled() {
            return;
        }
        log::info!(
            target: LOG_TARGET,
            "{}",
            connection_started_message(connection)
        );
    }

    pub fn record_connection_finished(
        &self,
        protocol: Protocol,
        outcome: DiagnosticConnectionOutcome,
    ) {
        if !self.is_enabled() {
            return;
        }
        let message = connection_finished_message(protocol, outcome);
        match outcome {
            DiagnosticConnectionOutcome::Failed(_) => {
                log::warn!(target: LOG_TARGET, "{message}")
            }
            _ => log::info!(target: LOG_TARGET, "{message}"),
        }
    }

    pub fn record_session_disconnected(&self, error: Option<DiagnosticError>) {
        if !self.is_enabled() {
            return;
        }
        match error {
            None => self.record("event=session_disconnected outcome=success"),
            Some(error) => log::warn!(
                target: LOG_TARGET,
                "event=session_disconnected outcome=failed error_code={} retryable={}",
                error_code_name(error.code()),
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
        error: DiagnosticError,
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
            error_code_name(error.code())
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

    pub fn record_transfer_failed(&self, direction: TransferDirection, error: DiagnosticError) {
        if !self.is_enabled() {
            return;
        }
        log::warn!(
            target: LOG_TARGET,
            "event=transfer_finished direction={} outcome=failed error_code={} retryable={}",
            transfer_direction_name(direction),
            error_code_name(error.code()),
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
        self.log_dir.join(ACTIVE_LOG_FILE_NAME)
    }

    pub fn clear_logs(&self) -> Result<(), AppError> {
        let _maintenance = self.maintenance.lock().map_err(|_| {
            AppError::new(
                ErrorCode::Internal,
                "Diagnostic log maintenance became unavailable",
            )
        })?;
        let was_enabled = self.enabled.swap(false, Ordering::AcqRel);
        let result = clear_diagnostics_logs(&self.log_dir);
        self.enabled.store(was_enabled, Ordering::Release);
        result
    }

    fn record(&self, message: &'static str) {
        if self.is_enabled() {
            log::info!(target: LOG_TARGET, "{message}");
        }
    }
}

#[derive(Clone, Copy)]
pub struct DiagnosticConnection {
    protocol: Protocol,
    auth: DiagnosticAuth,
    proxy: bool,
    proxy_jump: bool,
    custom_algorithms: bool,
}

impl DiagnosticConnection {
    pub fn from_profile(profile: &ConnectionProfile) -> Self {
        let algorithms = &profile.ssh_options.algorithms;
        Self {
            protocol: profile.protocol,
            auth: DiagnosticAuth::from(&profile.auth),
            proxy: profile.ssh_options.proxy.is_some(),
            proxy_jump: profile.ssh_options.proxy_jump_profile_id.is_some(),
            custom_algorithms: !algorithms.key_exchange.is_empty()
                || !algorithms.host_keys.is_empty()
                || !algorithms.ciphers.is_empty()
                || !algorithms.macs.is_empty(),
        }
    }

    pub fn protocol(self) -> Protocol {
        self.protocol
    }
}

#[derive(Clone, Copy)]
enum DiagnosticAuth {
    Anonymous,
    Password,
    PrivateKey,
    Agent,
}

impl From<&AuthRef> for DiagnosticAuth {
    fn from(auth: &AuthRef) -> Self {
        match auth {
            AuthRef::Anonymous => Self::Anonymous,
            AuthRef::Password { .. } => Self::Password,
            AuthRef::PrivateKey { .. } => Self::PrivateKey,
            AuthRef::Agent => Self::Agent,
        }
    }
}

#[derive(Clone, Copy)]
pub struct DiagnosticError {
    code: ErrorCode,
    retryable: bool,
}

impl DiagnosticError {
    pub fn from_error(error: &AppError) -> Self {
        Self {
            code: error.code,
            retryable: error.retryable,
        }
    }

    fn code(self) -> ErrorCode {
        self.code
    }
}

#[derive(Clone, Copy)]
pub enum DiagnosticConnectionOutcome {
    Connected,
    HostTrustRequired { changed_key: bool },
    CredentialRequired,
    Failed(DiagnosticError),
}

impl DiagnosticConnectionOutcome {
    pub fn from_result(result: &Result<ConnectResult, AppError>) -> Self {
        match result {
            Ok(ConnectResult::Connected { .. }) => Self::Connected,
            Ok(ConnectResult::NeedsHostTrust { challenge }) => Self::HostTrustRequired {
                changed_key: challenge.changed,
            },
            Ok(ConnectResult::NeedsCredential { .. }) => Self::CredentialRequired,
            Err(error) => Self::Failed(DiagnosticError::from_error(error)),
        }
    }
}

fn clear_diagnostics_logs(log_dir: &Path) -> Result<(), AppError> {
    let metadata = match fs::symlink_metadata(log_dir) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(diagnostics_io_error(error)),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(invalid_log_entry("The diagnostic log directory is unsafe"));
    }
    let entries = fs::read_dir(log_dir).map_err(diagnostics_io_error)?;
    for entry in entries {
        let entry = entry.map_err(diagnostics_io_error)?;
        let path = entry.path();
        match diagnostics_log_kind(&path) {
            Some(DiagnosticsLogKind::Active) => reset_active_log(&path)?,
            Some(DiagnosticsLogKind::Archive | DiagnosticsLogKind::Backup) => {
                remove_log_entry(&path)?
            }
            None => {}
        }
    }
    Ok(())
}

pub fn secure_log_storage_plugin<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("diagnostics-storage")
        .setup(|app, _api| {
            let log_dir = app.path().app_log_dir().map_err(|source| {
                diagnostics_io_error(io::Error::other(format!(
                    "could not locate the log directory: {source}"
                )))
            })?;
            prepare_log_storage(&log_dir)?;
            Ok(())
        })
        .build()
}

fn prepare_log_storage(log_dir: &Path) -> Result<(), AppError> {
    fs::create_dir_all(log_dir).map_err(diagnostics_io_error)?;
    let metadata = fs::symlink_metadata(log_dir).map_err(diagnostics_io_error)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(invalid_log_entry("The diagnostic log directory is unsafe"));
    }
    restrict_directory_permissions(log_dir)?;

    let legacy = log_dir.join(LEGACY_UNFILTERED_LOG_FILE_NAME);
    match fs::symlink_metadata(&legacy) {
        Ok(_) => remove_log_entry(&legacy)?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(diagnostics_io_error(error)),
    }

    let active = log_dir.join(ACTIVE_LOG_FILE_NAME);
    secure_active_log(&active)?;

    let entries = fs::read_dir(log_dir).map_err(diagnostics_io_error)?;
    for entry in entries {
        let entry = entry.map_err(diagnostics_io_error)?;
        let path = entry.path();
        match diagnostics_log_kind(&path) {
            Some(DiagnosticsLogKind::Archive) => secure_existing_log(&path)?,
            Some(DiagnosticsLogKind::Backup) => remove_log_entry(&path)?,
            _ => {}
        }
    }
    Ok(())
}

fn secure_active_log(path: &Path) -> Result<(), AppError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if safe_regular_file(&metadata) => restrict_file_permissions(path),
        Ok(metadata) if metadata.is_dir() => {
            Err(invalid_log_entry("The diagnostic log path is a directory"))
        }
        Ok(_) => {
            fs::remove_file(path).map_err(diagnostics_io_error)?;
            create_private_log(path)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => create_private_log(path),
        Err(error) => Err(diagnostics_io_error(error)),
    }
}

fn secure_existing_log(path: &Path) -> Result<(), AppError> {
    let metadata = fs::symlink_metadata(path).map_err(diagnostics_io_error)?;
    if safe_regular_file(&metadata) {
        restrict_file_permissions(path)
    } else if metadata.is_dir() {
        Err(invalid_log_entry(
            "A retained diagnostic log path is a directory",
        ))
    } else {
        fs::remove_file(path).map_err(diagnostics_io_error)
    }
}

fn reset_active_log(path: &Path) -> Result<(), AppError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return create_private_log(path),
        Err(error) => return Err(diagnostics_io_error(error)),
    };
    if !safe_regular_file(&metadata) {
        if metadata.is_dir() {
            return Err(invalid_log_entry(
                "The active diagnostic log path is a directory",
            ));
        }
        fs::remove_file(path).map_err(diagnostics_io_error)?;
        return create_private_log(path);
    }
    let file = OpenOptions::new()
        .write(true)
        .open(path)
        .map_err(diagnostics_io_error)?;
    let opened_metadata = file.metadata().map_err(diagnostics_io_error)?;
    if !safe_regular_file(&opened_metadata) {
        drop(file);
        fs::remove_file(path).map_err(diagnostics_io_error)?;
        return create_private_log(path);
    }
    file.set_len(0).map_err(diagnostics_io_error)?;
    restrict_file_permissions(path)
}

fn create_private_log(path: &Path) -> Result<(), AppError> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).map_err(diagnostics_io_error)?;
    restrict_file_permissions(path)
}

fn remove_log_entry(path: &Path) -> Result<(), AppError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(diagnostics_io_error(error)),
    };
    if metadata.is_dir() {
        return Err(invalid_log_entry(
            "A diagnostic log path unexpectedly contains a directory",
        ));
    }
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(diagnostics_io_error(error)),
    }
}

fn restrict_directory_permissions(path: &Path) -> Result<(), AppError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(diagnostics_io_error)?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn restrict_file_permissions(path: &Path) -> Result<(), AppError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(diagnostics_io_error)?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn safe_regular_file(metadata: &fs::Metadata) -> bool {
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() != 1 {
            return false;
        }
    }
    true
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DiagnosticsLogKind {
    Active,
    Archive,
    Backup,
}

fn diagnostics_log_kind(path: &Path) -> Option<DiagnosticsLogKind> {
    let name = path.file_name()?.to_str()?;
    if name == ACTIVE_LOG_FILE_NAME {
        return Some(DiagnosticsLogKind::Active);
    }
    let timestamp = name
        .strip_prefix(LOG_FILE_STEM)?
        .strip_prefix('_')?
        .strip_suffix(".log");
    if timestamp.is_some_and(valid_archive_timestamp) {
        return Some(DiagnosticsLogKind::Archive);
    }
    let timestamp = name
        .strip_prefix(LOG_FILE_STEM)?
        .strip_prefix('_')?
        .strip_suffix(".log.bak");
    timestamp
        .is_some_and(valid_archive_timestamp)
        .then_some(DiagnosticsLogKind::Backup)
}

fn valid_archive_timestamp(value: &str) -> bool {
    NaiveDateTime::parse_from_str(value, "%Y-%m-%d_%H-%M-%S").is_ok()
}

fn invalid_log_entry(message: &'static str) -> AppError {
    AppError::new(ErrorCode::Io, message)
}

fn diagnostics_io_error(source: io::Error) -> AppError {
    AppError::new(ErrorCode::Io, "Could not manage the diagnostic logs")
        .with_detail(source.to_string())
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

fn connection_started_message(connection: DiagnosticConnection) -> String {
    format!(
        "event=connection_started protocol={} auth={} proxy={} proxy_jump={} custom_algorithms={}",
        protocol_name(connection.protocol),
        auth_name(connection.auth),
        connection.proxy,
        connection.proxy_jump,
        connection.custom_algorithms,
    )
}

fn connection_finished_message(protocol: Protocol, outcome: DiagnosticConnectionOutcome) -> String {
    match outcome {
        DiagnosticConnectionOutcome::Connected => format!(
            "event=connection_finished protocol={} outcome=connected",
            protocol_name(protocol)
        ),
        DiagnosticConnectionOutcome::HostTrustRequired { changed_key } => format!(
            "event=connection_finished protocol={} outcome=host_trust_required changed_key={}",
            protocol_name(protocol),
            changed_key
        ),
        DiagnosticConnectionOutcome::CredentialRequired => format!(
            "event=connection_finished protocol={} outcome=credential_required",
            protocol_name(protocol)
        ),
        DiagnosticConnectionOutcome::Failed(error) => format!(
            "event=connection_finished protocol={} outcome=failed error_code={} retryable={}",
            protocol_name(protocol),
            error_code_name(error.code()),
            error.retryable
        ),
    }
}

fn auth_name(auth: DiagnosticAuth) -> &'static str {
    match auth {
        DiagnosticAuth::Anonymous => "anonymous",
        DiagnosticAuth::Password => "password",
        DiagnosticAuth::PrivateKey => "private_key",
        DiagnosticAuth::Agent => "agent",
    }
}
fn protocol_name(protocol: Protocol) -> &'static str {
    match protocol {
        Protocol::Sftp => "sftp",
        Protocol::Ftp => "ftp",
        Protocol::Ftps => "ftps",
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
        assert_eq!(
            diagnostics_log_kind(Path::new("siftlane-diagnostics.log")),
            Some(DiagnosticsLogKind::Active)
        );
        assert_eq!(
            diagnostics_log_kind(Path::new("siftlane-diagnostics_2026-07-28_12-00-00.log")),
            Some(DiagnosticsLogKind::Archive)
        );
        assert_eq!(
            diagnostics_log_kind(Path::new(
                "siftlane-diagnostics_2026-07-28_12-00-00.log.bak"
            )),
            Some(DiagnosticsLogKind::Backup)
        );
        assert_eq!(diagnostics_log_kind(Path::new("siftlane.log")), None);
        assert_eq!(
            diagnostics_log_kind(Path::new("siftlane-diagnostics-private.log")),
            None
        );
        assert_eq!(
            diagnostics_log_kind(Path::new("siftlane-diagnostics_2026-99-99_12-00-00.log")),
            None
        );
    }

    #[test]
    fn log_filter_requires_opt_in_and_the_exact_allowlisted_target() {
        let enabled = AtomicBool::new(false);
        let diagnostics = log::Metadata::builder()
            .target(LOG_TARGET)
            .level(log::Level::Info)
            .build();
        let unrelated = log::Metadata::builder()
            .target("siftlane_app_lib::commands")
            .level(log::Level::Error)
            .build();

        assert!(!log_metadata_allowed(&diagnostics, &enabled));
        enabled.store(true, Ordering::Relaxed);
        assert!(log_metadata_allowed(&diagnostics, &enabled));
        assert!(!log_metadata_allowed(&unrelated, &enabled));
    }

    #[test]
    fn clearing_logs_only_removes_diagnostics_files() {
        let directory = tempfile::tempdir().unwrap();
        let active = directory.path().join("siftlane-diagnostics.log");
        let archived = directory
            .path()
            .join("siftlane-diagnostics_2026-07-28_12-00-00.log");
        let backup = directory
            .path()
            .join("siftlane-diagnostics_2026-07-28_12-00-00.log.bak");
        let similar = directory.path().join("siftlane-diagnostics-private.log");
        let unrelated = directory.path().join("other.log");
        fs::write(&active, "active secret").unwrap();
        fs::write(&archived, "archived secret").unwrap();
        fs::write(&backup, "backup secret").unwrap();
        fs::write(&similar, "keep similar").unwrap();
        fs::write(&unrelated, "keep").unwrap();

        let diagnostics =
            Diagnostics::new(Arc::new(AtomicBool::new(false)), directory.path().into());
        diagnostics.clear_logs().unwrap();

        assert_eq!(fs::read_to_string(active).unwrap(), "");
        assert!(!archived.exists());
        assert!(!backup.exists());
        assert_eq!(fs::read_to_string(similar).unwrap(), "keep similar");
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

        let connection = DiagnosticConnection::from_profile(&profile);
        let started = connection_started_message(connection);
        let secret_error = AppError::new(ErrorCode::AuthenticationFailed, "SECRET_ERROR_MESSAGE")
            .with_detail("SECRET_ERROR_DETAIL");
        let failed = connection_finished_message(
            Protocol::Sftp,
            DiagnosticConnectionOutcome::Failed(DiagnosticError::from_error(&secret_error)),
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

    #[test]
    fn startup_removes_the_legacy_unfiltered_log_and_secures_storage() {
        let directory = tempfile::tempdir().unwrap();
        let legacy = directory.path().join(LEGACY_UNFILTERED_LOG_FILE_NAME);
        fs::write(&legacy, "possibly sensitive legacy entry").unwrap();

        prepare_log_storage(directory.path()).unwrap();

        assert!(!legacy.exists());
        assert!(directory.path().join(ACTIVE_LOG_FILE_NAME).is_file());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(directory.path()).unwrap().permissions().mode() & 0o777,
                0o700
            );
            assert_eq!(
                fs::metadata(directory.path().join(ACTIVE_LOG_FILE_NAME))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn startup_replaces_an_active_symlink_without_touching_its_target() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("target.txt");
        let active = directory.path().join(ACTIVE_LOG_FILE_NAME);
        fs::write(&target, "do not change").unwrap();
        symlink(&target, &active).unwrap();

        prepare_log_storage(directory.path()).unwrap();

        assert_eq!(fs::read_to_string(&target).unwrap(), "do not change");
        assert!(active.is_file());
        assert!(
            !fs::symlink_metadata(active)
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }

    #[cfg(unix)]
    #[test]
    fn startup_rejects_a_symlinked_log_directory() {
        use std::os::unix::fs::symlink;

        let parent = tempfile::tempdir().unwrap();
        let target = parent.path().join("target");
        let log_dir = parent.path().join("logs");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("keep.txt"), "do not change").unwrap();
        symlink(&target, &log_dir).unwrap();

        let error = prepare_log_storage(&log_dir).unwrap_err();

        assert_eq!(error.code, ErrorCode::Io);
        assert_eq!(
            fs::read_to_string(target.join("keep.txt")).unwrap(),
            "do not change"
        );
    }

    #[cfg(unix)]
    #[test]
    fn clearing_replaces_a_hard_link_without_truncating_its_target() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("target.txt");
        let active = directory.path().join(ACTIVE_LOG_FILE_NAME);
        fs::write(&target, "do not change").unwrap();
        fs::hard_link(&target, &active).unwrap();

        clear_diagnostics_logs(directory.path()).unwrap();

        assert_eq!(fs::read_to_string(&target).unwrap(), "do not change");
        assert_eq!(fs::read_to_string(active).unwrap(), "");
    }
}
