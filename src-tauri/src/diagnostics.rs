use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    panic::Location,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU8, Ordering},
    },
    time::Instant,
};

use chrono::{NaiveDateTime, Utc};
use serde::Serialize;
use sha2::{Digest, Sha256};
use siftlane_core::{
    AppError, AuthRef, ConnectResult, ConnectionProfile, ErrorCode, Protocol, TransferDirection,
};
use tauri::{Manager, Runtime, State, plugin::TauriPlugin};
use tauri_plugin_log::log;
use uuid::Uuid;
use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

use crate::state::AppState;

pub const LOG_FILE_STEM: &str = "siftlane-diagnostics";
pub const MAX_LOG_FILE_BYTES: u128 = 256 * 1024;
pub const RETAINED_ARCHIVED_LOG_FILES: usize = 2;
const LOG_TARGET: &str = "siftlane_diagnostics";
const ACTIVE_LOG_FILE_NAME: &str = "siftlane-diagnostics.log";
const LEGACY_UNFILTERED_LOG_FILE_NAME: &str = "siftlane.log";
const LIFECYCLE_MARKER_FILE_NAME: &str = "siftlane-diagnostics.session";
const DIAGNOSTICS_SCHEMA_VERSION: u8 = 2;
const SUPPORT_BUNDLE_SCHEMA_VERSION: u8 = 1;
const PHASE_STARTING: u8 = 0;
const PHASE_RUNNING: u8 = 1;
const PHASE_SHUTTING_DOWN: u8 = 2;
const MAX_SUPPORT_LOG_FILES: usize = 4;
const SUPPORT_BUNDLE_INCLUDED_DATA: [&str; 6] = [
    "Diagnostic event logs",
    "App and diagnostics schema versions",
    "Operating system and CPU architecture",
    "Random session and operation IDs with timings",
    "Bundle creation time and diagnostics status",
    "Log filenames, sizes, and SHA-256 checksums",
];
const SUPPORT_BUNDLE_EXCLUDED_DATA: [&str; 9] = [
    "Credentials and secret values",
    "Hosts and IP addresses",
    "Usernames",
    "Local and remote paths",
    "Filenames transferred by the user",
    "Commands",
    "File contents",
    "Free-form error messages",
    "Application configuration and database contents",
];

pub fn log_metadata_allowed(metadata: &log::Metadata<'_>, enabled: &AtomicBool) -> bool {
    enabled.load(Ordering::Relaxed) && metadata.target() == LOG_TARGET
}

#[derive(Clone)]
pub struct Diagnostics {
    enabled: Arc<AtomicBool>,
    log_dir: PathBuf,
    maintenance: Arc<Mutex<()>>,
    app_session_id: Uuid,
    lifecycle_phase: Arc<AtomicU8>,
    previous_exit_unclean: bool,
    support_bundle_snapshot: Arc<Mutex<Option<SupportBundleSnapshot>>>,
}

impl Diagnostics {
    pub fn new(enabled: Arc<AtomicBool>, log_dir: PathBuf) -> Result<Self, AppError> {
        let diagnostics = Self {
            enabled,
            log_dir,
            maintenance: Arc::new(Mutex::new(())),
            app_session_id: Uuid::new_v4(),
            lifecycle_phase: Arc::new(AtomicU8::new(PHASE_STARTING)),
            previous_exit_unclean: false,
            support_bundle_snapshot: Arc::new(Mutex::new(None)),
        };
        let previous_exit_unclean = if diagnostics.is_enabled() {
            diagnostics.begin_lifecycle()?
        } else {
            false
        };
        Ok(Self {
            previous_exit_unclean,
            ..diagnostics
        })
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
            let lifecycle_result = self.begin_lifecycle();
            self.enabled.store(true, Ordering::Relaxed);
            self.record_fixed("diagnostics_enabled");
            match lifecycle_result {
                Ok(true) => self.record_fixed("previous_exit_unclean_detected"),
                Ok(false) => {}
                Err(_) => self.record_fixed("lifecycle_marker_unavailable"),
            }
        } else {
            self.record_fixed("diagnostics_disabled");
            if self.end_lifecycle().is_err() {
                self.record_fixed("lifecycle_marker_cleanup_failed");
            }
            self.enabled.store(false, Ordering::Relaxed);
        }
    }

    pub fn record_app_started(&self) {
        self.lifecycle_phase.store(PHASE_RUNNING, Ordering::Release);
        if !self.is_enabled() {
            return;
        }
        log::info!(
            target: LOG_TARGET,
            "schema={} app_session_id={} event=app_started version={} os={} arch={} previous_exit_unclean={}",
            DIAGNOSTICS_SCHEMA_VERSION,
            self.app_session_id,
            env!("CARGO_PKG_VERSION"),
            std::env::consts::OS,
            std::env::consts::ARCH,
            self.previous_exit_unclean
        );
    }

    pub fn record_connection_started(
        &self,
        connection: DiagnosticConnection,
    ) -> DiagnosticOperation {
        let operation = DiagnosticOperation::new();
        if !self.is_enabled() {
            return operation;
        }
        log::info!(
            target: LOG_TARGET,
            "schema={} app_session_id={} operation_id={} {}",
            DIAGNOSTICS_SCHEMA_VERSION,
            self.app_session_id,
            operation.id,
            connection_started_message(connection),
        );
        operation
    }

    pub fn record_connection_finished(
        &self,
        operation: DiagnosticOperation,
        protocol: Protocol,
        outcome: DiagnosticConnectionOutcome,
    ) {
        if !self.is_enabled() {
            return;
        }
        let message = connection_finished_message(protocol, outcome, operation.elapsed_ms());
        match outcome {
            DiagnosticConnectionOutcome::Failed(_) => {
                log::warn!(
                    target: LOG_TARGET,
                    "schema={} app_session_id={} operation_id={} {message}",
                    DIAGNOSTICS_SCHEMA_VERSION,
                    self.app_session_id,
                    operation.id
                )
            }
            _ => log::info!(
                target: LOG_TARGET,
                "schema={} app_session_id={} operation_id={} {message}",
                DIAGNOSTICS_SCHEMA_VERSION,
                self.app_session_id,
                operation.id
            ),
        }
    }

    pub fn record_session_disconnected(&self, error: Option<DiagnosticError>) {
        if !self.is_enabled() {
            return;
        }
        let operation = DiagnosticOperation::new();
        match error {
            None => log::info!(
                target: LOG_TARGET,
                "schema={} app_session_id={} operation_id={} event=session_disconnected outcome=success duration_ms={}",
                DIAGNOSTICS_SCHEMA_VERSION,
                self.app_session_id,
                operation.id,
                operation.elapsed_ms()
            ),
            Some(error) => log::warn!(
                target: LOG_TARGET,
                "schema={} app_session_id={} operation_id={} event=session_disconnected outcome=failed error_code={} retryable={} duration_ms={}",
                DIAGNOSTICS_SCHEMA_VERSION,
                self.app_session_id,
                operation.id,
                error_code_name(error.code()),
                error.retryable,
                operation.elapsed_ms()
            ),
        }
    }

    pub fn new_operation(&self) -> DiagnosticOperation {
        DiagnosticOperation::new()
    }

    pub fn record_transfer_started(
        &self,
        operation: DiagnosticOperation,
        direction: TransferDirection,
    ) {
        if !self.is_enabled() {
            return;
        }
        log::info!(
            target: LOG_TARGET,
            "schema={} app_session_id={} operation_id={} event=transfer_started direction={}",
            DIAGNOSTICS_SCHEMA_VERSION,
            self.app_session_id,
            operation.id,
            transfer_direction_name(direction)
        );
    }

    pub fn record_transfer_retry(
        &self,
        operation: DiagnosticOperation,
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
            "schema={} app_session_id={} operation_id={} event=transfer_retry direction={} attempt={} limit={} error_code={} elapsed_ms={}",
            DIAGNOSTICS_SCHEMA_VERSION,
            self.app_session_id,
            operation.id,
            transfer_direction_name(direction),
            attempt,
            limit,
            error_code_name(error.code()),
            operation.elapsed_ms()
        );
    }

    pub fn record_transfer_completed(
        &self,
        operation: DiagnosticOperation,
        direction: TransferDirection,
        retry_count: u8,
    ) {
        if !self.is_enabled() {
            return;
        }
        log::info!(
            target: LOG_TARGET,
            "schema={} app_session_id={} operation_id={} event=transfer_finished direction={} outcome=completed retries={} duration_ms={}",
            DIAGNOSTICS_SCHEMA_VERSION,
            self.app_session_id,
            operation.id,
            transfer_direction_name(direction),
            retry_count,
            operation.elapsed_ms()
        );
    }

    pub fn record_transfer_failed(
        &self,
        operation: DiagnosticOperation,
        direction: TransferDirection,
        error: DiagnosticError,
    ) {
        if !self.is_enabled() {
            return;
        }
        log::warn!(
            target: LOG_TARGET,
            "schema={} app_session_id={} operation_id={} event=transfer_finished direction={} outcome=failed error_code={} retryable={} duration_ms={}",
            DIAGNOSTICS_SCHEMA_VERSION,
            self.app_session_id,
            operation.id,
            transfer_direction_name(direction),
            error_code_name(error.code()),
            error.retryable,
            operation.elapsed_ms()
        );
    }

    pub fn record_search_started(&self, scope: SearchScope) -> DiagnosticOperation {
        let operation = DiagnosticOperation::new();
        if !self.is_enabled() {
            return operation;
        }
        log::info!(
            target: LOG_TARGET,
            "schema={} app_session_id={} operation_id={} event=search_started scope={}",
            DIAGNOSTICS_SCHEMA_VERSION,
            self.app_session_id,
            operation.id,
            scope.as_str()
        );
        operation
    }

    pub fn record_search_finished(
        &self,
        operation: DiagnosticOperation,
        scope: SearchScope,
        error: Option<ErrorCode>,
    ) {
        if !self.is_enabled() {
            return;
        }
        match error {
            Some(code) => log::warn!(
                target: LOG_TARGET,
                "schema={} app_session_id={} operation_id={} event=search_finished scope={} outcome=failed error_code={} duration_ms={}",
                DIAGNOSTICS_SCHEMA_VERSION,
                self.app_session_id,
                operation.id,
                scope.as_str(),
                error_code_name(code),
                operation.elapsed_ms()
            ),
            None => log::info!(
                target: LOG_TARGET,
                "schema={} app_session_id={} operation_id={} event=search_finished scope={} outcome=success duration_ms={}",
                DIAGNOSTICS_SCHEMA_VERSION,
                self.app_session_id,
                operation.id,
                scope.as_str(),
                operation.elapsed_ms()
            ),
        }
    }

    pub fn record_panic(&self, location: Option<&Location<'_>>) {
        if !self.is_enabled() {
            return;
        }
        let (component, line) = sanitized_panic_location(location);
        log::error!(
            target: LOG_TARGET,
            "schema={} app_session_id={} event=panic component={} line={} lifecycle_phase={}",
            DIAGNOSTICS_SCHEMA_VERSION,
            self.app_session_id,
            component,
            line,
            lifecycle_phase_name(self.lifecycle_phase.load(Ordering::Acquire))
        );
    }

    pub fn record_clean_shutdown(&self) {
        if self
            .lifecycle_phase
            .swap(PHASE_SHUTTING_DOWN, Ordering::AcqRel)
            == PHASE_SHUTTING_DOWN
        {
            return;
        }
        self.record_fixed("app_shutdown_clean");
        if self.end_lifecycle().is_err() {
            self.record_fixed("lifecycle_marker_cleanup_failed");
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

    pub fn support_bundle_preview(&self) -> Result<SupportBundlePreview, AppError> {
        let _maintenance = self.maintenance.lock().map_err(|_| {
            AppError::new(
                ErrorCode::Internal,
                "Diagnostic log maintenance became unavailable",
            )
        })?;
        let was_enabled = self.enabled.swap(false, Ordering::AcqRel);
        let files = collect_support_logs(&self.log_dir);
        self.enabled.store(was_enabled, Ordering::Release);
        let files = files?;
        let snapshot = SupportBundleSnapshot {
            id: Uuid::new_v4(),
            created_at_utc: Utc::now().to_rfc3339(),
            diagnostics_enabled: was_enabled,
            app_session_id: self.app_session_id,
            files,
        };
        let preview = support_bundle_preview(&snapshot);
        *self.support_bundle_snapshot.lock().map_err(|_| {
            AppError::new(
                ErrorCode::Internal,
                "The support bundle preview became unavailable",
            )
        })? = Some(snapshot);
        Ok(preview)
    }

    pub fn export_support_bundle(
        &self,
        preview_id: Uuid,
        destination: &Path,
    ) -> Result<(), AppError> {
        let _maintenance = self.maintenance.lock().map_err(|_| {
            AppError::new(
                ErrorCode::Internal,
                "Diagnostic log maintenance became unavailable",
            )
        })?;
        let mut snapshot = self.support_bundle_snapshot.lock().map_err(|_| {
            AppError::new(
                ErrorCode::Internal,
                "The support bundle preview became unavailable",
            )
        })?;
        let reviewed = snapshot
            .as_ref()
            .filter(|snapshot| snapshot.id == preview_id)
            .ok_or_else(|| {
                AppError::new(
                    ErrorCode::InvalidInput,
                    "Review the support bundle again before exporting it",
                )
            })?;
        let result = write_support_bundle(&self.log_dir, destination, reviewed);
        if result.is_ok() {
            *snapshot = None;
        }
        result
    }

    fn begin_lifecycle(&self) -> Result<bool, AppError> {
        reset_lifecycle_marker(
            &self.log_dir.join(LIFECYCLE_MARKER_FILE_NAME),
            self.app_session_id,
        )
    }

    fn end_lifecycle(&self) -> Result<(), AppError> {
        remove_log_entry(&self.log_dir.join(LIFECYCLE_MARKER_FILE_NAME))
    }

    fn record_fixed(&self, event: &'static str) {
        if self.is_enabled() {
            log::info!(
                target: LOG_TARGET,
                "schema={} app_session_id={} event={}",
                DIAGNOSTICS_SCHEMA_VERSION,
                self.app_session_id,
                event
            );
        }
    }
}

#[derive(Clone, Copy)]
pub struct DiagnosticOperation {
    id: Uuid,
    started_at: Instant,
}

impl DiagnosticOperation {
    fn new() -> Self {
        Self {
            id: Uuid::new_v4(),
            started_at: Instant::now(),
        }
    }

    fn elapsed_ms(self) -> u128 {
        self.started_at.elapsed().as_millis()
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

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SupportBundleLogFile {
    pub name: String,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SupportBundlePreview {
    pub preview_id: Uuid,
    pub created_at_utc: String,
    pub bundle_schema_version: u8,
    pub diagnostics_schema_version: u8,
    pub app_version: String,
    pub operating_system: String,
    pub architecture: String,
    pub diagnostics_enabled: bool,
    pub log_files: Vec<SupportBundleLogFile>,
    pub total_log_bytes: u64,
    pub included_data: Vec<String>,
    pub excluded_data: Vec<String>,
}

#[derive(Debug)]
struct SupportLog {
    name: String,
    contents: Vec<u8>,
}

#[derive(Debug)]
struct SupportBundleSnapshot {
    id: Uuid,
    created_at_utc: String,
    diagnostics_enabled: bool,
    app_session_id: Uuid,
    files: Vec<SupportLog>,
}

#[derive(Serialize)]
struct SupportBundleManifest {
    bundle_schema_version: u8,
    diagnostics_schema_version: u8,
    created_at_utc: String,
    app_version: &'static str,
    operating_system: &'static str,
    architecture: &'static str,
    diagnostics_enabled_when_reviewed: bool,
    app_session_id: Uuid,
    included_data: Vec<&'static str>,
    excluded_data: Vec<&'static str>,
    log_files: Vec<SupportBundleManifestLog>,
}

#[derive(Serialize)]
struct SupportBundleManifestLog {
    name: String,
    bytes: u64,
    sha256: String,
}

fn support_bundle_preview(snapshot: &SupportBundleSnapshot) -> SupportBundlePreview {
    let log_files = snapshot
        .files
        .iter()
        .map(|file| SupportBundleLogFile {
            name: file.name.clone(),
            bytes: file.contents.len() as u64,
            sha256: format!("{:x}", Sha256::digest(&file.contents)),
        })
        .collect::<Vec<_>>();
    SupportBundlePreview {
        preview_id: snapshot.id,
        created_at_utc: snapshot.created_at_utc.clone(),
        bundle_schema_version: SUPPORT_BUNDLE_SCHEMA_VERSION,
        diagnostics_schema_version: DIAGNOSTICS_SCHEMA_VERSION,
        app_version: env!("CARGO_PKG_VERSION").into(),
        operating_system: std::env::consts::OS.into(),
        architecture: std::env::consts::ARCH.into(),
        diagnostics_enabled: snapshot.diagnostics_enabled,
        total_log_bytes: log_files.iter().map(|file| file.bytes).sum(),
        log_files,
        included_data: SUPPORT_BUNDLE_INCLUDED_DATA
            .into_iter()
            .map(str::to_owned)
            .collect(),
        excluded_data: SUPPORT_BUNDLE_EXCLUDED_DATA
            .into_iter()
            .map(str::to_owned)
            .collect(),
    }
}

fn collect_support_logs(log_dir: &Path) -> Result<Vec<SupportLog>, AppError> {
    let metadata = fs::symlink_metadata(log_dir).map_err(diagnostics_io_error)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(invalid_log_entry("The diagnostic log directory is unsafe"));
    }

    let mut candidates = Vec::new();
    for entry in fs::read_dir(log_dir).map_err(diagnostics_io_error)? {
        let path = entry.map_err(diagnostics_io_error)?.path();
        if let Some(kind) = diagnostics_log_kind(&path) {
            candidates.push((kind, path));
        }
    }
    candidates.sort_by(|left, right| match (left.0, right.0) {
        (DiagnosticsLogKind::Active, DiagnosticsLogKind::Active) => std::cmp::Ordering::Equal,
        (DiagnosticsLogKind::Active, _) => std::cmp::Ordering::Less,
        (_, DiagnosticsLogKind::Active) => std::cmp::Ordering::Greater,
        _ => right.1.file_name().cmp(&left.1.file_name()),
    });
    candidates.truncate(MAX_SUPPORT_LOG_FILES);

    candidates
        .into_iter()
        .map(|(_, path)| {
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or_else(|| invalid_log_entry("A diagnostic log name is invalid"))?
                .to_owned();
            let mut file = open_diagnostic_log(&path)?;
            let metadata = file.metadata().map_err(diagnostics_io_error)?;
            if !safe_regular_file(&metadata) {
                return Err(invalid_log_entry("A diagnostic log file is unsafe"));
            }
            if metadata.len() > MAX_LOG_FILE_BYTES as u64 {
                return Err(invalid_log_entry(
                    "A diagnostic log file exceeds the retention limit",
                ));
            }
            let mut contents = Vec::with_capacity(metadata.len() as usize);
            file.read_to_end(&mut contents)
                .map_err(diagnostics_io_error)?;
            Ok(SupportLog { name, contents })
        })
        .collect()
}

fn open_diagnostic_log(path: &Path) -> Result<File, AppError> {
    let metadata = fs::symlink_metadata(path).map_err(diagnostics_io_error)?;
    if !safe_regular_file(&metadata) {
        return Err(invalid_log_entry("A diagnostic log file is unsafe"));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    options.open(path).map_err(diagnostics_io_error)
}

fn write_support_bundle(
    log_dir: &Path,
    destination: &Path,
    snapshot: &SupportBundleSnapshot,
) -> Result<(), AppError> {
    let parent = validate_support_bundle_destination(log_dir, destination)?;
    let manifest_logs = snapshot
        .files
        .iter()
        .map(|file| SupportBundleManifestLog {
            name: file.name.clone(),
            bytes: file.contents.len() as u64,
            sha256: format!("{:x}", Sha256::digest(&file.contents)),
        })
        .collect();
    let manifest = SupportBundleManifest {
        bundle_schema_version: SUPPORT_BUNDLE_SCHEMA_VERSION,
        diagnostics_schema_version: DIAGNOSTICS_SCHEMA_VERSION,
        created_at_utc: snapshot.created_at_utc.clone(),
        app_version: env!("CARGO_PKG_VERSION"),
        operating_system: std::env::consts::OS,
        architecture: std::env::consts::ARCH,
        diagnostics_enabled_when_reviewed: snapshot.diagnostics_enabled,
        app_session_id: snapshot.app_session_id,
        included_data: SUPPORT_BUNDLE_INCLUDED_DATA.to_vec(),
        excluded_data: SUPPORT_BUNDLE_EXCLUDED_DATA.to_vec(),
        log_files: manifest_logs,
    };
    let manifest_json = serde_json::to_vec_pretty(&manifest).map_err(|source| {
        AppError::new(
            ErrorCode::Internal,
            "Could not serialize the support bundle manifest",
        )
        .with_detail(source.to_string())
    })?;

    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(diagnostics_io_error)?;
    {
        let mut zip = ZipWriter::new(temporary.as_file_mut());
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .unix_permissions(0o600);
        zip.start_file("manifest.json", options)
            .map_err(support_bundle_zip_error)?;
        zip.write_all(&manifest_json)
            .map_err(diagnostics_io_error)?;
        for file in &snapshot.files {
            zip.start_file(format!("logs/{}", file.name), options)
                .map_err(support_bundle_zip_error)?;
            zip.write_all(&file.contents)
                .map_err(diagnostics_io_error)?;
        }
        zip.finish().map_err(support_bundle_zip_error)?;
    }
    temporary
        .as_file()
        .sync_all()
        .map_err(diagnostics_io_error)?;
    temporary
        .persist(destination)
        .map_err(|error| diagnostics_io_error(error.error))?;
    restrict_file_permissions(destination)
}

fn validate_support_bundle_destination<'a>(
    log_dir: &Path,
    destination: &'a Path,
) -> Result<&'a Path, AppError> {
    if !destination
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
    {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "Support bundles must use the .zip extension",
        ));
    }
    let parent = destination.parent().ok_or_else(|| {
        AppError::new(
            ErrorCode::InvalidInput,
            "The support bundle destination is invalid",
        )
    })?;
    let canonical_parent = fs::canonicalize(parent).map_err(diagnostics_io_error)?;
    let canonical_log_dir = fs::canonicalize(log_dir).map_err(diagnostics_io_error)?;
    if canonical_parent.starts_with(&canonical_log_dir) {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "Support bundles cannot be saved in the diagnostic log directory",
        ));
    }
    match fs::symlink_metadata(destination) {
        Ok(metadata) if !safe_regular_file(&metadata) => {
            return Err(AppError::new(
                ErrorCode::InvalidInput,
                "The support bundle destination is unsafe",
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(diagnostics_io_error(error)),
    }
    Ok(parent)
}

fn support_bundle_zip_error(source: zip::result::ZipError) -> AppError {
    AppError::new(ErrorCode::Io, "Could not create the support bundle")
        .with_detail(source.to_string())
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

fn reset_lifecycle_marker(path: &Path, app_session_id: Uuid) -> Result<bool, AppError> {
    let existed = match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() => {
            return Err(invalid_log_entry(
                "The diagnostic lifecycle marker is a directory",
            ));
        }
        Ok(metadata) if safe_regular_file(&metadata) => true,
        Ok(_) => {
            remove_log_entry(path)?;
            false
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => false,
        Err(error) => return Err(diagnostics_io_error(error)),
    };

    if existed {
        let mut options = OpenOptions::new();
        options.write(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW);
        }
        let mut file = options.open(path).map_err(diagnostics_io_error)?;
        if !safe_regular_file(&file.metadata().map_err(diagnostics_io_error)?) {
            drop(file);
            remove_log_entry(path)?;
            return create_lifecycle_marker(path, app_session_id).map(|()| true);
        }
        file.write_all(app_session_id.to_string().as_bytes())
            .map_err(diagnostics_io_error)?;
        file.sync_all().map_err(diagnostics_io_error)?;
        restrict_file_permissions(path)?;
        Ok(true)
    } else {
        create_lifecycle_marker(path, app_session_id)?;
        Ok(false)
    }
}

fn create_lifecycle_marker(path: &Path, app_session_id: Uuid) -> Result<(), AppError> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(diagnostics_io_error)?;
    file.write_all(app_session_id.to_string().as_bytes())
        .map_err(diagnostics_io_error)?;
    file.sync_all().map_err(diagnostics_io_error)?;
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

fn sanitized_panic_location(location: Option<&Location<'_>>) -> (&'static str, u32) {
    let Some(location) = location else {
        return ("unknown", 0);
    };
    let file = location.file().replace('\\', "/");
    let component = if file.contains("crates/siftlane-sftp/") {
        "sftp"
    } else if file.contains("crates/siftlane-ftp/") {
        "ftp"
    } else if file.contains("crates/siftlane-core/") {
        "core"
    } else if file.contains("src-tauri/src/") {
        "app_backend"
    } else {
        "dependency_or_runtime"
    };
    (component, location.line())
}

fn lifecycle_phase_name(phase: u8) -> &'static str {
    match phase {
        PHASE_STARTING => "starting",
        PHASE_RUNNING => "running",
        PHASE_SHUTTING_DOWN => "shutting_down",
        _ => "unknown",
    }
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

fn connection_finished_message(
    protocol: Protocol,
    outcome: DiagnosticConnectionOutcome,
    duration_ms: u128,
) -> String {
    match outcome {
        DiagnosticConnectionOutcome::Connected => format!(
            "event=connection_finished protocol={} outcome=connected duration_ms={duration_ms}",
            protocol_name(protocol),
        ),
        DiagnosticConnectionOutcome::HostTrustRequired { changed_key } => format!(
            "event=connection_finished protocol={} outcome=host_trust_required changed_key={} duration_ms={duration_ms}",
            protocol_name(protocol),
            changed_key
        ),
        DiagnosticConnectionOutcome::CredentialRequired => format!(
            "event=connection_finished protocol={} outcome=credential_required duration_ms={duration_ms}",
            protocol_name(protocol),
        ),
        DiagnosticConnectionOutcome::Failed(error) => format!(
            "event=connection_finished protocol={} outcome=failed error_code={} retryable={} duration_ms={duration_ms}",
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

#[tauri::command]
pub fn get_support_bundle_preview(
    state: State<'_, AppState>,
) -> Result<SupportBundlePreview, AppError> {
    state.diagnostics.support_bundle_preview()
}

#[tauri::command]
pub fn export_support_bundle(
    state: State<'_, AppState>,
    preview_id: Uuid,
    path: PathBuf,
) -> Result<(), AppError> {
    state.diagnostics.export_support_bundle(preview_id, &path)
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
            Diagnostics::new(Arc::new(AtomicBool::new(false)), directory.path().into()).unwrap();
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
            42,
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
        assert!(output.contains("duration_ms=42"));
    }

    #[test]
    fn support_bundle_contains_only_reviewed_diagnostics_and_manifest() {
        let directory = tempfile::tempdir().unwrap();
        let log_dir = directory.path().join("logs");
        prepare_log_storage(&log_dir).unwrap();
        fs::write(
            log_dir.join(ACTIVE_LOG_FILE_NAME),
            "schema=2 event=app_started",
        )
        .unwrap();
        fs::write(
            log_dir.join("unrelated-database.txt"),
            "SECRET_DATABASE_CONTENT",
        )
        .unwrap();
        let diagnostics =
            Diagnostics::new(Arc::new(AtomicBool::new(false)), log_dir.clone()).unwrap();

        let preview = diagnostics.support_bundle_preview().unwrap();
        assert_eq!(
            preview.log_files,
            vec![SupportBundleLogFile {
                name: ACTIVE_LOG_FILE_NAME.into(),
                bytes: 26,
                sha256: format!("{:x}", Sha256::digest(b"schema=2 event=app_started")),
            }]
        );
        assert!(
            preview
                .excluded_data
                .contains(&"Application configuration and database contents".into())
        );
        fs::write(
            log_dir.join(ACTIVE_LOG_FILE_NAME),
            "schema=2 event=newer_unreviewed_event",
        )
        .unwrap();

        let destination = directory.path().join("support.zip");
        let error = diagnostics
            .export_support_bundle(Uuid::new_v4(), &destination)
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidInput);
        assert!(!destination.exists());
        diagnostics
            .export_support_bundle(preview.preview_id, &destination)
            .unwrap();
        let mut archive = zip::ZipArchive::new(File::open(destination).unwrap()).unwrap();
        assert_eq!(archive.len(), 2);

        let mut manifest_json = String::new();
        archive
            .by_name("manifest.json")
            .unwrap()
            .read_to_string(&mut manifest_json)
            .unwrap();
        let manifest: serde_json::Value = serde_json::from_str(&manifest_json).unwrap();
        assert_eq!(manifest["bundle_schema_version"], 1);
        assert_eq!(manifest["diagnostics_schema_version"], 2);
        assert_eq!(
            manifest["log_files"][0]["name"],
            serde_json::Value::String(ACTIVE_LOG_FILE_NAME.into())
        );

        let mut log = String::new();
        archive
            .by_name(&format!("logs/{ACTIVE_LOG_FILE_NAME}"))
            .unwrap()
            .read_to_string(&mut log)
            .unwrap();
        assert_eq!(log, "schema=2 event=app_started");
        assert!(!manifest_json.contains("SECRET_DATABASE_CONTENT"));
        assert!(archive.by_name("unrelated-database.txt").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn support_bundle_rejects_a_symlink_destination_without_touching_its_target() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().unwrap();
        let log_dir = directory.path().join("logs");
        prepare_log_storage(&log_dir).unwrap();
        let diagnostics = Diagnostics::new(Arc::new(AtomicBool::new(false)), log_dir).unwrap();
        let preview = diagnostics.support_bundle_preview().unwrap();
        let target = directory.path().join("keep.txt");
        let destination = directory.path().join("support.zip");
        fs::write(&target, "do not replace").unwrap();
        symlink(&target, &destination).unwrap();

        let error = diagnostics
            .export_support_bundle(preview.preview_id, &destination)
            .unwrap_err();

        assert_eq!(error.code, ErrorCode::InvalidInput);
        assert_eq!(fs::read_to_string(target).unwrap(), "do not replace");
    }

    #[test]
    fn lifecycle_marker_detects_an_unclean_previous_exit() {
        let directory = tempfile::tempdir().unwrap();
        prepare_log_storage(directory.path()).unwrap();
        let first =
            Diagnostics::new(Arc::new(AtomicBool::new(true)), directory.path().into()).unwrap();
        assert!(!first.previous_exit_unclean);
        assert!(directory.path().join(LIFECYCLE_MARKER_FILE_NAME).is_file());

        let second =
            Diagnostics::new(Arc::new(AtomicBool::new(true)), directory.path().into()).unwrap();
        assert!(second.previous_exit_unclean);
        second.record_clean_shutdown();
        assert!(!directory.path().join(LIFECYCLE_MARKER_FILE_NAME).exists());
    }

    #[test]
    fn panic_location_is_reduced_to_a_safe_component_and_line() {
        let (component, line) = sanitized_panic_location(Some(Location::caller()));
        assert_eq!(component, "app_backend");
        assert!(line > 0);
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
