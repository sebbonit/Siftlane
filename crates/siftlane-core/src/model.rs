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
            created_at: now,
            updated_at: now,
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
pub enum SavedActionKind {
    OpenLocal,
    OpenRemote,
    OpenBoth,
    UploadDir,
    DownloadDir,
    PackageLocal,
    PackageRemote,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SavedAction {
    pub id: Uuid,
    pub label: String,
    pub kind: SavedActionKind,
    pub local_path: Option<String>,
    pub remote_path: Option<String>,
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

impl TransferState {
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TransferJob {
    pub id: TransferId,
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
    pub speed_bytes_per_second: Option<u64>,
    pub error: Option<String>,
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
            speed_bytes_per_second: None,
            error: None,
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
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Preferences {
    pub theme: Theme,
    pub default_layout: LayoutMode,
    pub show_hidden_files: bool,
    pub global_parallel_transfers: u8,
    pub per_host_parallel_transfers: u8,
    pub connect_timeout_seconds: u64,
    pub response_timeout_seconds: u64,
    pub keepalive_seconds: u64,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            theme: Theme::System,
            default_layout: LayoutMode::DualPane,
            show_hidden_files: true,
            global_parallel_transfers: 3,
            per_host_parallel_transfers: 2,
            connect_timeout_seconds: 15,
            response_timeout_seconds: 30,
            keepalive_seconds: 30,
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
