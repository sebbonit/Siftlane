export type UUID = string;

export type AuthRef =
  | { kind: "anonymous" }
  | { kind: "password"; remember: boolean }
  | { kind: "private_key"; path: string; remember_passphrase: boolean }
  | { kind: "agent" };

export interface ConnectionProfile {
  id: UUID;
  label: string;
  protocol: "sftp" | "ftp" | "ftps";
  host: string;
  port: number;
  username: string;
  auth: AuthRef;
  initial_remote_path: string;
  favorite: boolean;
  created_at: string;
  updated_at: string;
}

export type EntryKind = "file" | "directory" | "symlink" | "other";

export interface FileEntry {
  path: string;
  name: string;
  kind: EntryKind;
  size: number | null;
  modified_at: string | null;
  permissions: number | null;
  symlink_target: string | null;
  hidden: boolean;
}

export interface EditableFile {
  path: string;
  name: string;
  content: string;
  language: string;
  size: number;
  privileged?: boolean;
}

export interface PreviewFile {
  path: string;
  name: string;
  mime: string;
  data_base64: string;
  size: number;
}

export interface HostKeyChallenge {
  challenge_id: UUID;
  host: string;
  port: number;
  algorithm: string;
  fingerprint_sha256: string;
  changed: boolean;
}

export type ConnectResult =
  | { status: "connected"; session_id: UUID }
  | { status: "needs_host_trust"; challenge: HostKeyChallenge }
  | { status: "needs_credential"; profile_id: UUID };

export type TransferDirection = "upload" | "download";
export type ConflictPolicy = "ask" | "skip" | "overwrite" | "rename";
export type DirectoryTransferMode = "include_root" | "contents_only";
export type SymlinkPolicy = "skip" | "copy_link" | "dereference";
export type TransferPriority = "low" | "normal" | "high";
export type TransferState =
  | "queued"
  | "running"
  | "paused"
  | "waiting_for_conflict"
  | "waiting_for_authentication"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";
export type TransferVerification = "pending" | "size_verified" | "sha256_verified";

export interface TransferJob {
  id: UUID;
  batch_id: UUID | null;
  profile_id: UUID;
  direction: TransferDirection;
  source_path: string;
  destination_path: string;
  partial_path: string;
  bytes_total: number | null;
  bytes_transferred: number;
  state: TransferState;
  conflict_policy: ConflictPolicy;
  retry_count: number;
  verification: TransferVerification;
  speed_bytes_per_second: number | null;
  error: string | null;
  priority?: TransferPriority;
  preserve_modified_time?: boolean;
  preserve_permissions?: boolean;
  symlink_policy?: SymlinkPolicy;
  retry_history?: Array<{ at: string; error: string }>;
  created_at: string;
  updated_at: string;
}

export interface TransferProgress {
  id: UUID;
  state: TransferState;
  bytes_transferred: number;
  bytes_total: number | null;
  speed_bytes_per_second: number | null;
  retry_count: number;
  verification: TransferVerification;
  error: string | null;
}

export type Theme =
  | "system"
  | "light"
  | "dark"
  | "midnight"
  | "ocean"
  | "graphite";

export interface Preferences {
  theme: Theme;
  default_layout: "dual_pane" | "remote_focused";
  show_hidden_files: boolean;
  global_parallel_transfers: number;
  per_host_parallel_transfers: number;
  expand_transfers_on_new: boolean;
  automatic_retry_limit: number;
  connect_timeout_seconds: number;
  response_timeout_seconds: number;
  keepalive_seconds: number;
  /** Per-connection collapsed bookmark tile order (profile id → favorite ids). */
  bookmark_order: Record<string, string[]>;
  restore_sessions: boolean;
  global_upload_limit_bps: number | null;
  global_download_limit_bps: number | null;
  profile_bandwidth_limits: Record<
    string,
    { upload_bps: number | null; download_bps: number | null }
  >;
  bandwidth_schedules: BandwidthSchedule[];
  temporary_bandwidth_limit: TemporaryBandwidthLimit | null;
  sync_roots: Record<string, SyncRootPair>;
}

export interface BandwidthSchedule {
  id: UUID;
  label: string;
  start_time: string;
  end_time: string;
  upload_bps: number | null;
  download_bps: number | null;
  days: number[];
  enabled: boolean;
}

export interface TemporaryBandwidthLimit {
  upload_bps: number | null;
  download_bps: number | null;
  expires_at: string;
}

export interface SyncRootPair {
  local_root: string;
  remote_root: string;
  enabled: boolean;
}

export type ComparisonStatus =
  | "same"
  | "local_only"
  | "remote_only"
  | "local_newer"
  | "remote_newer"
  | "size_mismatch";

export type SyncMode = "upload_mirror" | "download_mirror" | "two_way";

export interface AppError {
  code: string;
  message: string;
  retryable: boolean;
  detail?: string;
}

export interface SessionTab {
  id: UUID;
  profileId: UUID;
  label: string;
  host: string;
  protocol: ConnectionProfile["protocol"];
  localPath: string;
  remotePath: string;
  layout: "dual_pane" | "remote_focused";
  connected: boolean;
}

export interface RestoredSessionState {
  tabs: SessionTab[];
  activeTabId: UUID | null;
}

export type SavedActionKind =
  | "open_local"
  | "open_remote"
  | "open_both"
  | "upload_dir"
  | "download_dir"
  | "package_local"
  | "package_remote"
  | "package_and_download"
  | "run_remote_commands";

export type ArchiveFormat = "zip" | "tar" | "tar_gz";

export interface RemoteCommandResult {
  command: string;
  exit_status: number | null;
  stdout: string;
  stderr: string;
}

export interface SavedAction {
  id: UUID;
  label: string;
  kind: SavedActionKind;
  local_path: string | null;
  remote_path: string | null;
  archive_format?: ArchiveFormat | null;
  /** Shell commands for `run_remote_commands` (one entry per command). */
  commands?: string[];
  created_at: string;
  updated_at: string;
}

export type FavoriteSide = "local" | "remote";

export interface Favorite {
  id: UUID;
  profile_id: UUID | null;
  side: FavoriteSide;
  label: string;
  path: string;
}

export interface SearchMatch {
  path: string;
  name: string;
  kind: EntryKind;
  parent_path: string;
}

export interface SearchProgress {
  search_id: UUID;
  matches: SearchMatch[];
  visited: number;
  truncated: boolean;
  done: boolean;
  cancelled: boolean;
  error?: string | null;
}
