use chrono::{DateTime, Utc};
use secrecy::SecretString;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub type ProfileId = Uuid;
pub type SessionId = Uuid;
pub type TransferId = Uuid;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Protocol {
    Sftp,
    Ftp,
    Ftps,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AuthRef {
    Anonymous,
    Password {
        remember: bool,
    },
    PrivateKey {
        path: String,
        remember_passphrase: bool,
    },
    Agent,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConnectionProfile {
    pub id: ProfileId,
    pub label: String,
    pub protocol: Protocol,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthRef,
    pub initial_remote_path: String,
    pub favorite: bool,
    #[serde(default)]
    pub ssh_options: SshOptions,
    #[serde(default)]
    pub folder: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub notes: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl ConnectionProfile {
    pub fn new(label: String, host: String, username: String, auth: AuthRef) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4(),
            label,
            protocol: Protocol::Sftp,
            host,
            port: 22,
            username,
            auth,
            initial_remote_path: "/".into(),
            favorite: false,
            ssh_options: SshOptions::default(),
            folder: None,
            tags: Vec::new(),
            color: None,
            notes: String::new(),
            created_at: now,
            updated_at: now,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct SshOptions {
    pub proxy_jump_profile_id: Option<ProfileId>,
    pub proxy: Option<SshProxy>,
    #[serde(default)]
    pub agent_forwarding: AgentForwardingPolicy,
    #[serde(default)]
    pub algorithms: SshAlgorithmPolicy,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SshProxyKind {
    Socks5,
    HttpConnect,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SshProxy {
    pub kind: SshProxyKind,
    pub host: String,
    pub port: u16,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentForwardingPolicy {
    #[default]
    Deny,
    Allow,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct SshAlgorithmPolicy {
    #[serde(default)]
    pub key_exchange: Vec<String>,
    #[serde(default)]
    pub host_keys: Vec<String>,
    #[serde(default)]
    pub ciphers: Vec<String>,
    #[serde(default)]
    pub macs: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FavoriteSide {
    Local,
    Remote,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Favorite {
    pub id: Uuid,
    pub profile_id: Option<ProfileId>,
    pub side: FavoriteSide,
    pub label: String,
    pub path: String,
}

impl Favorite {
    pub fn new(
        profile_id: Option<ProfileId>,
        side: FavoriteSide,
        label: String,
        path: String,
    ) -> Self {
        Self {
            id: Uuid::new_v4(),
            profile_id,
            side,
            label,
            path,
        }
    }
}

impl Protocol {
    pub const fn default_port(self) -> u16 {
        match self {
            Self::Sftp => 22,
            Self::Ftp | Self::Ftps => 21,
        }
    }
}

#[derive(Debug)]
pub enum SecretInput {
    Password(SecretString),
    PrivateKeyPassphrase(SecretString),
    None,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EntryKind {
    File,
    Directory,
    Symlink,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FileEntry {
    pub path: String,
    pub name: String,
    pub kind: EntryKind,
    pub size: Option<u64>,
    pub modified_at: Option<DateTime<Utc>>,
    pub permissions: Option<u32>,
    pub symlink_target: Option<String>,
    pub hidden: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ArchiveFormat {
    Zip,
    Tar,
    TarGz,
}

impl ArchiveFormat {
    pub fn extension(self) -> &'static str {
        match self {
            Self::Zip => "zip",
            Self::Tar => "tar",
            Self::TarGz => "tar.gz",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SavedActionKind {
    OpenLocal,
    OpenRemote,
    OpenBoth,
    UploadDir,
    DownloadDir,
    PackageLocal,
    PackageRemote,
    PackageAndDownload,
    RunRemoteCommands,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SavedAction {
    pub id: Uuid,
    pub label: String,
    pub kind: SavedActionKind,
    pub local_path: Option<String>,
    pub remote_path: Option<String>,
    #[serde(default)]
    pub archive_format: Option<ArchiveFormat>,
    /// Shell commands to run remotely for [`SavedActionKind::RunRemoteCommands`].
    #[serde(default)]
    pub commands: Vec<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl SavedAction {
    pub fn new(
        label: String,
        kind: SavedActionKind,
        local_path: Option<String>,
        remote_path: Option<String>,
    ) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4(),
            label,
            kind,
            local_path,
            remote_path,
            archive_format: None,
            commands: Vec::new(),
            created_at: now,
            updated_at: now,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HostKeyChallenge {
    pub challenge_id: Uuid,
    pub host: String,
    pub port: u16,
    pub algorithm: String,
    pub fingerprint_sha256: String,
    pub changed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TrustedHostKey {
    pub host: String,
    pub port: u16,
    pub algorithm: String,
    pub fingerprint_sha256: String,
    pub first_seen_at: DateTime<Utc>,
    pub last_seen_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct KnownHostsImportSummary {
    pub imported: usize,
    pub skipped: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ConnectResult {
    Connected { session_id: SessionId },
    NeedsHostTrust { challenge: HostKeyChallenge },
    NeedsCredential { profile_id: ProfileId },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TransferDirection {
    Upload,
    Download,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConflictPolicy {
    Ask,
    Skip,
    Overwrite,
    Rename,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TransferState {
    Queued,
    Running,
    Paused,
    WaitingForConflict,
    WaitingForAuthentication,
    Completed,
    Failed,
    Cancelled,
    Interrupted,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TransferVerification {
    #[default]
    Pending,
    SizeVerified,
    Sha256Verified,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum TransferPriority {
    Low,
    #[default]
    Normal,
    High,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SymlinkPolicy {
    #[default]
    Skip,
    CopyLink,
    Dereference,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RetryRecord {
    pub at: DateTime<Utc>,
    pub error: String,
}

impl TransferState {
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TransferJob {
    pub id: TransferId,
    #[serde(default)]
    pub batch_id: Option<Uuid>,
    pub profile_id: ProfileId,
    pub direction: TransferDirection,
    pub source_path: String,
    pub destination_path: String,
    pub partial_path: String,
    pub bytes_total: Option<u64>,
    pub bytes_transferred: u64,
    pub state: TransferState,
    pub conflict_policy: ConflictPolicy,
    pub retry_count: u8,
    #[serde(default)]
    pub verification: TransferVerification,
    pub speed_bytes_per_second: Option<u64>,
    pub error: Option<String>,
    #[serde(default)]
    pub priority: TransferPriority,
    #[serde(default)]
    pub preserve_modified_time: bool,
    #[serde(default)]
    pub preserve_permissions: bool,
    #[serde(default)]
    pub symlink_policy: SymlinkPolicy,
    #[serde(default)]
    pub retry_history: Vec<RetryRecord>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl TransferJob {
    pub fn new(
        profile_id: ProfileId,
        direction: TransferDirection,
        source_path: String,
        destination_path: String,
        bytes_total: Option<u64>,
    ) -> Self {
        let id = Uuid::new_v4();
        let partial_path = format!("{destination_path}.siftlane-part-{id}");
        let now = Utc::now();
        Self {
            id,
            batch_id: None,
            profile_id,
            direction,
            source_path,
            destination_path,
            partial_path,
            bytes_total,
            bytes_transferred: 0,
            state: TransferState::Queued,
            conflict_policy: ConflictPolicy::Ask,
            retry_count: 0,
            verification: TransferVerification::Pending,
            speed_bytes_per_second: None,
            error: None,
            priority: TransferPriority::Normal,
            preserve_modified_time: false,
            preserve_permissions: false,
            symlink_policy: SymlinkPolicy::Skip,
            retry_history: Vec::new(),
            created_at: now,
            updated_at: now,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TransferProgress {
    pub id: TransferId,
    pub state: TransferState,
    pub bytes_transferred: u64,
    pub bytes_total: Option<u64>,
    pub speed_bytes_per_second: Option<u64>,
    pub retry_count: u8,
    pub verification: TransferVerification,
    pub error: Option<String>,
}

fn default_expand_transfers_on_new() -> bool {
    true
}

fn default_automatic_retry_limit() -> u8 {
    3
}

fn default_restore_sessions() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct ProfileBandwidthLimit {
    pub upload_bps: Option<u64>,
    pub download_bps: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BandwidthSchedule {
    pub id: Uuid,
    pub label: String,
    pub start_time: String,
    pub end_time: String,
    pub upload_bps: Option<u64>,
    pub download_bps: Option<u64>,
    pub days: Vec<u8>,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TemporaryBandwidthLimit {
    pub upload_bps: Option<u64>,
    pub download_bps: Option<u64>,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct SyncRootPair {
    pub local_root: String,
    pub remote_root: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Preferences {
    pub theme: Theme,
    pub default_layout: LayoutMode,
    pub show_hidden_files: bool,
    pub global_parallel_transfers: u8,
    pub per_host_parallel_transfers: u8,
    #[serde(default = "default_expand_transfers_on_new")]
    pub expand_transfers_on_new: bool,
    #[serde(default = "default_automatic_retry_limit")]
    pub automatic_retry_limit: u8,
    pub connect_timeout_seconds: u64,
    pub response_timeout_seconds: u64,
    pub keepalive_seconds: u64,
    /// Per-connection collapsed bookmark tile order (profile id → favorite ids).
    #[serde(default)]
    pub bookmark_order: std::collections::BTreeMap<String, Vec<String>>,
    #[serde(default = "default_restore_sessions")]
    pub restore_sessions: bool,
    #[serde(default)]
    pub global_upload_limit_bps: Option<u64>,
    #[serde(default)]
    pub global_download_limit_bps: Option<u64>,
    #[serde(default)]
    pub profile_bandwidth_limits: std::collections::BTreeMap<String, ProfileBandwidthLimit>,
    #[serde(default)]
    pub bandwidth_schedules: Vec<BandwidthSchedule>,
    #[serde(default)]
    pub temporary_bandwidth_limit: Option<TemporaryBandwidthLimit>,
    #[serde(default)]
    pub sync_roots: std::collections::BTreeMap<String, SyncRootPair>,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            theme: Theme::System,
            default_layout: LayoutMode::DualPane,
            show_hidden_files: true,
            global_parallel_transfers: 3,
            per_host_parallel_transfers: 2,
            expand_transfers_on_new: true,
            automatic_retry_limit: 3,
            connect_timeout_seconds: 15,
            response_timeout_seconds: 30,
            keepalive_seconds: 30,
            bookmark_order: std::collections::BTreeMap::new(),
            restore_sessions: true,
            global_upload_limit_bps: None,
            global_download_limit_bps: None,
            profile_bandwidth_limits: std::collections::BTreeMap::new(),
            bandwidth_schedules: Vec::new(),
            temporary_bandwidth_limit: None,
            sync_roots: std::collections::BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Theme {
    System,
    Light,
    Dark,
    Midnight,
    Ocean,
    Graphite,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LayoutMode {
    DualPane,
    RemoteFocused,
}
