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

export interface TransferJob {
  id: UUID;
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
  speed_bytes_per_second: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface TransferProgress {
  id: UUID;
  state: TransferState;
  bytes_transferred: number;
  bytes_total: number | null;
  speed_bytes_per_second: number | null;
  error: string | null;
}

export interface Preferences {
  theme: "system" | "light" | "dark";
  default_layout: "dual_pane" | "remote_focused";
  show_hidden_files: boolean;
  global_parallel_transfers: number;
  per_host_parallel_transfers: number;
  connect_timeout_seconds: number;
  response_timeout_seconds: number;
  keepalive_seconds: number;
}

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
