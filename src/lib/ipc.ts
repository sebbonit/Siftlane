import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { homeDir } from "@tauri-apps/api/path";
import { confirm as confirmDialog, open as openDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type {
  AppError,
  ConflictPolicy,
  ConnectResult,
  ConnectionProfile,
  FileEntry,
  EditableFile,
  Preferences,
  TransferDirection,
  TransferJob,
  TransferProgress,
  UUID,
} from "../types";

const mockProfiles: ConnectionProfile[] = [
  {
    id: "demo-production",
    label: "Production",
    protocol: "sftp",
    host: "sftp.example.com",
    port: 22,
    username: "deploy",
    auth: { kind: "agent" },
    initial_remote_path: "/var/www/html",
    favorite: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: "demo-assets",
    label: "Media archive",
    protocol: "ftps",
    host: "files.example.com",
    port: 21,
    username: "publisher",
    auth: { kind: "password", remember: true },
    initial_remote_path: "/incoming",
    favorite: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: "demo-staging",
    label: "Staging",
    protocol: "sftp",
    host: "staging.example.com",
    port: 22,
    username: "deploy",
    auth: { kind: "private_key", path: "~/.ssh/id_ed25519", remember_passphrase: true },
    initial_remote_path: "/srv/staging",
    favorite: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
];

const demoMode =
  !isTauri() &&
  (import.meta.env.VITE_DEMO_DATA === "1" ||
    new URLSearchParams(window.location.search).get("demo") === "1");
let localDemo: FileEntry[] = demoEntries("/Users/alex/Projects/my-website", true);
let remoteDemo: FileEntry[] = demoEntries("/var/www/html", false);
let browserProfiles = demoMode ? [...mockProfiles] : [];
let browserTransfers: TransferJob[] = demoMode
  ? [
      mockTransfer("app.js", 0.72, "upload", "running"),
      mockTransfer("images/hero.jpg", 0.41, "upload", "running"),
      mockTransfer("style.css", 1, "upload", "completed"),
    ]
  : [];

function demoEntries(base: string, local: boolean): FileEntry[] {
  const values: Array<[string, FileEntry["kind"], number | null]> = [
    ["assets", "directory", null],
    ["css", "directory", null],
    ["images", "directory", null],
    ["js", "directory", null],
    ["vendor", "directory", null],
    [local ? ".gitignore" : ".htaccess", "file", local ? 243 : 1240],
    ["about.html", "file", 4300],
    ["contact.html", "file", 3600],
    ["index.html", "file", 7200],
    [local ? "package.json" : "robots.txt", "file", local ? 1100 : 312],
  ];
  return values.map(([name, kind, size], index) => ({
    path: `${base}/${name}`,
    name,
    kind,
    size,
    modified_at: new Date(Date.now() - index * 3_600_000).toISOString(),
    permissions: kind === "directory" ? 0o755 : 0o644,
    symlink_target: null,
    hidden: name.startsWith("."),
  }));
}

function mockTransfer(
  name: string,
  progress: number,
  direction: TransferDirection,
  state: TransferJob["state"],
): TransferJob {
  const total = 3_300_000;
  return {
    id: crypto.randomUUID(),
    profile_id: "demo-production",
    direction,
    source_path: `/Users/alex/Projects/my-website/${name}`,
    destination_path: `/var/www/html/${name}`,
    partial_path: `/var/www/html/${name}.part`,
    bytes_total: total,
    bytes_transferred: Math.floor(total * progress),
    state,
    conflict_policy: "ask",
    retry_count: 0,
    speed_bytes_per_second: state === "running" ? 1_240_000 : null,
    error: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

export const desktop = isTauri();

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    if (typeof error === "object" && error && "message" in error) {
      throw error as AppError;
    }
    throw { code: "internal", message: String(error), retryable: false } satisfies AppError;
  }
}

export const api = {
  async pickPrivateKey() {
    if (!desktop) return null;
    let defaultPath: string | undefined;
    try {
      const home = await homeDir();
      defaultPath = `${home.replace(/[\\/]$/, "")}/.ssh`;
    } catch {
      // The picker remains usable if the operating system cannot resolve a home directory.
    }
    const selected = await openDialog({
      title: "Choose an SSH private key",
      multiple: false,
      directory: false,
      defaultPath,
    });
    return typeof selected === "string" ? selected : null;
  },
  async pickDirectory(defaultPath?: string) {
    if (!desktop) return null;
    const selected = await openDialog({
      title: "Choose folder",
      multiple: false,
      directory: true,
      defaultPath,
    });
    return typeof selected === "string" ? selected : null;
  },
  async revealInFileManager(path: string) {
    if (!desktop) return;
    await revealItemInDir(path);
  },
  async listProfiles() {
    return desktop ? call<ConnectionProfile[]>("list_profiles") : browserProfiles;
  },
  async saveProfile(profile: ConnectionProfile) {
    if (desktop) return call<ConnectionProfile>("save_profile", { profile });
    browserProfiles = [...browserProfiles.filter((item) => item.id !== profile.id), profile];
    return profile;
  },
  async deleteProfile(profileId: UUID) {
    if (desktop) return call<void>("delete_profile", { profileId });
    browserProfiles = browserProfiles.filter((profile) => profile.id !== profileId);
  },
  async connectProfile(profileId: UUID, credential?: string) {
    if (desktop) return call<ConnectResult>("connect_profile", { profileId, credential });
    return { status: "connected", session_id: `session-${profileId}` } satisfies ConnectResult;
  },
  trustHostKey(challengeId: UUID, accept: boolean) {
    return call<ConnectResult | null>("trust_host_key", { challengeId, accept });
  },
  disconnectSession(sessionId: UUID) {
    return desktop ? call<void>("disconnect_session", { sessionId }) : Promise.resolve();
  },
  async defaultLocalPath() {
    return desktop
      ? call<string>("get_default_local_path")
      : demoMode
        ? "/Users/alex/Projects/my-website"
        : "/";
  },
  async listLocal(path: string) {
    return desktop
      ? call<FileEntry[]>("list_local_directory", { path })
      : demoMode
        ? localDemo
        : [];
  },
  async listRemote(sessionId: UUID, path: string) {
    return desktop
      ? call<FileEntry[]>("list_remote_directory", { sessionId, path })
      : demoMode
        ? remoteDemo
        : [];
  },
  async readLocalFile(path: string) {
    if (desktop) return call<EditableFile>("read_local_file", { path });
    return demoFile(path);
  },
  async readLocalFilePrivileged(path: string, sudoPassword?: string) {
    if (desktop) return call<EditableFile>("read_local_file_privileged", { path, sudoPassword });
    return { ...demoFile(path), privileged: true };
  },
  async readRemoteFile(sessionId: UUID, path: string) {
    if (desktop) return call<EditableFile>("read_remote_file", { sessionId, path });
    return demoFile(path);
  },
  async readRemoteFilePrivileged(sessionId: UUID, path: string, sudoPassword?: string) {
    if (desktop) return call<EditableFile>("read_remote_file_privileged", { sessionId, path, sudoPassword });
    return { ...demoFile(path), privileged: true };
  },
  async saveLocalFile(path: string, content: string) {
    if (desktop) return call<void>("save_local_file", { path, content });
  },
  async saveLocalFilePrivileged(path: string, content: string, sudoPassword?: string) {
    if (desktop) return call<void>("save_local_file_privileged", { path, content, sudoPassword });
  },
  async saveRemoteFile(sessionId: UUID, path: string, content: string) {
    if (desktop) return call<void>("save_remote_file", { sessionId, path, content });
  },
  async saveRemoteFilePrivileged(sessionId: UUID, path: string, content: string, sudoPassword?: string) {
    if (desktop) return call<void>("save_remote_file_privileged", { sessionId, path, content, sudoPassword });
  },
  async formatRust(content: string) {
    if (desktop) return call<string>("format_rust", { content });
    return content;
  },
  async createLocalEntry(parentPath: string, name: string, directory: boolean) {
    if (desktop) return call<void>("create_local_entry", { parentPath, name, directory });
    if (demoMode) localDemo = [...localDemo, browserEntry(parentPath, name, directory)];
  },
  async createLocalEntryPrivileged(parentPath: string, name: string, directory: boolean, sudoPassword?: string) {
    if (desktop) return call<void>("create_local_entry_privileged", { parentPath, name, directory, sudoPassword });
    if (demoMode) localDemo = [...localDemo, browserEntry(parentPath, name, directory)];
  },
  async deleteLocalEntry(path: string, directory: boolean) {
    if (desktop) return call<void>("delete_local_entry", { path, directory });
    localDemo = localDemo.filter((entry) => entry.path !== path);
  },
  async deleteLocalEntryPrivileged(path: string, directory: boolean, sudoPassword?: string) {
    if (desktop) return call<void>("delete_local_entry_privileged", { path, directory, sudoPassword });
    localDemo = localDemo.filter((entry) => entry.path !== path);
  },
  async createRemoteEntry(
    sessionId: UUID,
    parentPath: string,
    name: string,
    directory: boolean,
  ) {
    if (desktop) {
      return call<void>("create_remote_entry", { sessionId, parentPath, name, directory });
    }
    if (demoMode) remoteDemo = [...remoteDemo, browserEntry(parentPath, name, directory)];
  },
  async createRemoteEntryPrivileged(sessionId: UUID, parentPath: string, name: string, directory: boolean, sudoPassword?: string) {
    if (desktop) return call<void>("create_remote_entry_privileged", { sessionId, parentPath, name, directory, sudoPassword });
    if (demoMode) remoteDemo = [...remoteDemo, browserEntry(parentPath, name, directory)];
  },
  async deleteRemoteEntry(sessionId: UUID, path: string, directory: boolean) {
    if (desktop) return call<void>("delete_remote_entry", { sessionId, path, directory });
    remoteDemo = remoteDemo.filter((entry) => entry.path !== path);
  },
  async deleteRemoteEntryPrivileged(sessionId: UUID, path: string, directory: boolean, sudoPassword?: string) {
    if (desktop) return call<void>("delete_remote_entry_privileged", { sessionId, path, directory, sudoPassword });
    remoteDemo = remoteDemo.filter((entry) => entry.path !== path);
  },
  async setLocalPermissions(path: string, permissions: number) {
    if (desktop) return call<void>("set_local_permissions", { path, permissions });
    localDemo = localDemo.map((entry) =>
      entry.path === path ? { ...entry, permissions } : entry,
    );
  },
  async setRemotePermissions(sessionId: UUID, path: string, permissions: number) {
    if (desktop) return call<void>("set_remote_permissions", { sessionId, path, permissions });
    remoteDemo = remoteDemo.map((entry) =>
      entry.path === path ? { ...entry, permissions } : entry,
    );
  },
  async getLocalDirectorySize(path: string) {
    if (desktop) return call<number>("get_local_directory_size", { path });
    return localDemo
      .filter((entry) => entry.path.startsWith(`${path.replace(/[\\/]$/, "")}/`) && entry.kind === "file")
      .reduce((sum, entry) => sum + (entry.size ?? 0), 0);
  },
  async getRemoteDirectorySize(sessionId: UUID, path: string) {
    if (desktop) return call<number>("get_remote_directory_size", { sessionId, path });
    void sessionId;
    return remoteDemo
      .filter((entry) => entry.path.startsWith(`${path.replace(/[\\/]$/, "")}/`) && entry.kind === "file")
      .reduce((sum, entry) => sum + (entry.size ?? 0), 0);
  },
  async confirmDelete(name: string, directory: boolean) {
    const message = `Delete ${directory ? "folder" : "file"} “${name}”? This cannot be undone.`;
    return desktop
      ? confirmDialog(message, { title: "Delete entry", kind: "warning" })
      : window.confirm(message);
  },
  async listTransfers() {
    return desktop ? call<TransferJob[]>("list_transfers") : browserTransfers;
  },
  async clearTransfers(filter: "all" | "active" | "completed" | "failed") {
    if (desktop) return call<TransferJob[]>("clear_transfers", { filter });
    if (filter === "all") {
      browserTransfers = [];
      return browserTransfers;
    }
    const matches =
      filter === "active"
        ? (state: TransferJob["state"]) => !["completed", "failed", "cancelled"].includes(state)
        : filter === "completed"
          ? (state: TransferJob["state"]) => state === "completed"
          : (state: TransferJob["state"]) => ["failed", "cancelled"].includes(state);
    browserTransfers = browserTransfers.filter((job) => !matches(job.state));
    return browserTransfers;
  },
  async enqueueTransfer(draft: {
    profileId: UUID;
    direction: TransferDirection;
    sourcePath: string;
    destinationPath: string;
    conflictPolicy?: ConflictPolicy;
  }) {
    if (desktop) return call<TransferJob>("enqueue_transfer", { draft });
    const name = draft.sourcePath.split(/[\\/]/).pop() ?? "transfer";
    const job = mockTransfer(name, 0, draft.direction, "queued");
    browserTransfers = [job, ...browserTransfers];
    return job;
  },
  controlTransfer(transferId: UUID, action: "pause" | "resume" | "cancel" | "retry") {
    return desktop
      ? call<TransferJob>("control_transfer", { transferId, action })
      : Promise.resolve(browserTransfers.find((job) => job.id === transferId)!);
  },
  resolveConflict(transferId: UUID, policy: "skip" | "overwrite") {
    return call<TransferJob>("resolve_transfer_conflict", { transferId, policy });
  },
  async getPreferences() {
    if (desktop) return call<Preferences>("get_preferences");
    return {
      theme: "system",
      default_layout: "dual_pane",
      show_hidden_files: true,
      global_parallel_transfers: 3,
      per_host_parallel_transfers: 2,
      connect_timeout_seconds: 15,
      response_timeout_seconds: 30,
      keepalive_seconds: 30,
    } satisfies Preferences;
  },
  savePreferences(preferences: Preferences) {
    return desktop ? call<void>("save_preferences", { preferences }) : Promise.resolve();
  },
  async onTransferProgress(callback: (progress: TransferProgress) => void): Promise<UnlistenFn> {
    if (!desktop) return () => undefined;
    return listen<TransferProgress>("transfer-progress", ({ payload }) => callback(payload));
  },
};

function demoFile(path: string): EditableFile {
  const name = path.split(/[\\/]/).pop() ?? "file.txt";
  const content = name.endsWith(".html")
    ? `<!doctype html>\n<html>\n  <head><title>Preview</title></head>\n  <body>\n    <h1>Edit this remote file</h1>\n  </body>\n</html>\n`
    : name.endsWith(".css") ? `body {\n  color: #202827;\n}\n` : `# ${name}\n\nEdit this file and save it back to the server.\n`;
  return { path, name, content, language: languageFor(name), size: new TextEncoder().encode(content).length, privileged: false };
}

function languageFor(name: string) {
  const extension = name.split(".").pop()?.toLowerCase();
  return extension === "html" || extension === "htm" ? "HTML" : extension === "css" ? "CSS" : extension === "ts" || extension === "tsx" ? "TypeScript" : extension === "js" || extension === "jsx" ? "JavaScript" : extension === "json" ? "JSON" : extension === "md" ? "Markdown" : extension === "rs" ? "Rust" : "Plain text";
}

function browserEntry(parentPath: string, name: string, directory: boolean): FileEntry {
  return {
    path: `${parentPath.replace(/[\\/]$/, "")}/${name}`,
    name,
    kind: directory ? "directory" : "file",
    size: directory ? null : 0,
    modified_at: new Date().toISOString(),
    permissions: directory ? 0o755 : 0o644,
    symlink_target: null,
    hidden: name.startsWith("."),
  };
}
