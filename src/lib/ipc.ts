import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { homeDir } from "@tauri-apps/api/path";
import { confirm as confirmDialog, open as openDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type {
  AppError,
  ArchiveFormat,
  ConflictPolicy,
  ConnectResult,
  ConnectionProfile,
  DirectoryTransferMode,
  Favorite,
  FileEntry,
  EditableFile,
  Preferences,
  PreviewFile,
  SavedAction,
  SearchMatch,
  SearchProgress,
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
const LOCAL_DEMO_ROOT = "/Users/alex/Projects/my-website";
const REMOTE_DEMO_ROOT = "/var/www/html";
let localDemoTree = buildDemoTree(LOCAL_DEMO_ROOT, true);
let remoteDemoTree = buildDemoTree(REMOTE_DEMO_ROOT, false);
const demoSearchCancel = new Map<string, boolean>();
const demoSearchListeners = new Set<(progress: SearchProgress) => void>();

function emitDemoSearch(progress: SearchProgress) {
  for (const listener of demoSearchListeners) listener(progress);
}
let browserProfiles = demoMode ? [...mockProfiles] : [];
let browserTransfers: TransferJob[] = demoMode
  ? [
      mockTransfer("app.js", 0.72, "upload", "running"),
      mockTransfer("images/hero.jpg", 0.41, "upload", "running"),
      mockTransfer("style.css", 1, "upload", "completed"),
    ]
  : [];
let browserSavedActions: SavedAction[] = [];
let browserFavorites: Favorite[] = [];

function demoEntry(
  base: string,
  name: string,
  kind: FileEntry["kind"],
  size: number | null,
  index: number,
): FileEntry {
  return {
    path: `${base.replace(/\/+$/, "")}/${name}`,
    name,
    kind,
    size,
    modified_at: new Date(Date.now() - index * 3_600_000).toISOString(),
    permissions: kind === "directory" ? 0o755 : 0o644,
    symlink_target: null,
    hidden: name.startsWith("."),
  };
}

function buildDemoTree(root: string, local: boolean): Record<string, FileEntry[]> {
  const nest = (base: string, values: Array<[string, FileEntry["kind"], number | null]>) =>
    values.map(([name, kind, size], index) => demoEntry(base, name, kind, size, index));

  const assets = `${root}/assets`;
  const images = `${root}/images`;
  const css = `${root}/css`;
  const js = `${root}/js`;
  return {
    [root]: nest(root, [
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
    ]),
    [assets]: nest(assets, [
      ["logo.svg", "file", 1840],
      ["brand.png", "file", 22_400],
    ]),
    [images]: nest(images, [
      ["hero.jpg", "file", 1_240_000],
      ["thumb.png", "file", 48_200],
    ]),
    [css]: nest(css, [["style.css", "file", 3100]]),
    [js]: nest(js, [["app.js", "file", 8600]]),
    [`${root}/vendor`]: [],
  };
}

function demoList(tree: Record<string, FileEntry[]>, path: string): FileEntry[] {
  const normalized = path.replace(/\/+$/, "") || "/";
  return tree[normalized] ?? tree[path] ?? [];
}

function demoParent(path: string, remote: boolean): string {
  const normalized = path.replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return remote ? "/" : normalized.slice(0, Math.max(1, index + 1)) || "/";
  return normalized.slice(0, index) || "/";
}

function demoAddEntry(
  tree: Record<string, FileEntry[]>,
  parentPath: string,
  name: string,
  directory: boolean,
): Record<string, FileEntry[]> {
  const parent = parentPath.replace(/\/+$/, "") || "/";
  const entry = browserEntry(parent, name, directory);
  const next = { ...tree, [parent]: [...(tree[parent] ?? []), entry] };
  if (directory) next[entry.path] = next[entry.path] ?? [];
  return next;
}

function demoRemoveEntry(
  tree: Record<string, FileEntry[]>,
  path: string,
): Record<string, FileEntry[]> {
  const parent = demoParent(path, true);
  const next: Record<string, FileEntry[]> = {};
  for (const [key, entries] of Object.entries(tree)) {
    if (key === path || key.startsWith(`${path}/`)) continue;
    next[key] = key === parent ? entries.filter((entry) => entry.path !== path) : entries;
  }
  return next;
}

function demoRenameEntry(
  tree: Record<string, FileEntry[]>,
  from: string,
  to: string,
): Record<string, FileEntry[]> {
  const fromParent = demoParent(from, true);
  const toParent = demoParent(to, true);
  const name = to.split("/").filter(Boolean).pop() ?? to;
  const source = (tree[fromParent] ?? []).find((entry) => entry.path === from);
  if (!source) return tree;

  const next: Record<string, FileEntry[]> = {};
  for (const [key, entries] of Object.entries(tree)) {
    if (key === from || key.startsWith(`${from}/`)) continue;
    next[key] = entries.filter((entry) => entry.path !== from);
  }
  next[toParent] = [...(next[toParent] ?? []), { ...source, path: to, name }];
  if (source.kind === "directory") {
    for (const [key, entries] of Object.entries(tree)) {
      if (key !== from && !key.startsWith(`${from}/`)) continue;
      const renamedKey = key === from ? to : `${to}${key.slice(from.length)}`;
      next[renamedKey] = entries.map((entry) => ({
        ...entry,
        path: entry.path === from ? to : `${to}${entry.path.slice(from.length)}`,
        name:
          entry.path === from
            ? name
            : entry.path.slice(from.length + 1).split("/").pop() ?? entry.name,
      }));
    }
  }
  return next;
}

function demoUpdatePermissions(
  tree: Record<string, FileEntry[]>,
  path: string,
  permissions: number,
): Record<string, FileEntry[]> {
  const next: Record<string, FileEntry[]> = {};
  for (const [key, entries] of Object.entries(tree)) {
    next[key] = entries.map((entry) =>
      entry.path === path ? { ...entry, permissions } : entry,
    );
  }
  return next;
}

function demoAllFiles(tree: Record<string, FileEntry[]>, root: string): FileEntry[] {
  const prefix = root.replace(/\/+$/, "");
  return Object.values(tree)
    .flat()
    .filter(
      (entry) =>
        entry.kind === "file" &&
        (entry.path === prefix || entry.path.startsWith(`${prefix}/`)),
    );
}

const DEMO_SKIP_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "target",
  "dist",
  "build",
  "vendor",
  "__pycache__",
  ".next",
  ".cache",
]);

async function runDemoSearch(
  tree: Record<string, FileEntry[]>,
  root: string,
  query: string,
  remote: boolean,
): Promise<UUID> {
  const searchId = crypto.randomUUID();
  demoSearchCancel.set(searchId, false);
  const needle = query.trim().toLowerCase();
  queueMicrotask(() => {
    const callback = emitDemoSearch;
    if (!needle) {
      callback({
        search_id: searchId,
        matches: [],
        visited: 0,
        truncated: false,
        done: true,
        cancelled: false,
      });
      demoSearchCancel.delete(searchId);
      return;
    }

    const matches: SearchMatch[] = [];
    let visited = 0;
    let truncated = false;
    const queue: Array<{ path: string; depth: number }> = [
      { path: root.replace(/\/+$/, "") || "/", depth: 0 },
    ];
    const maxMatches = 500;
    const maxVisited = 1500;
    const maxDepth = 32;

    while (queue.length > 0) {
      if (demoSearchCancel.get(searchId)) {
        callback({
          search_id: searchId,
          matches: [],
          visited,
          truncated,
          done: true,
          cancelled: true,
        });
        demoSearchCancel.delete(searchId);
        return;
      }
      if (visited >= maxVisited || matches.length >= maxMatches) {
        truncated = true;
        break;
      }
      const current = queue.shift()!;
      if (current.depth > maxDepth) {
        truncated = true;
        continue;
      }
      visited += 1;
      const batch: SearchMatch[] = [];
      const preferred: string[] = [];
      const other: string[] = [];
      for (const entry of demoList(tree, current.path)) {
        if (entry.kind === "symlink" || entry.kind === "other") continue;
        if (entry.name.toLowerCase().includes(needle)) {
          const item = {
            path: entry.path,
            name: entry.name,
            kind: entry.kind,
            parent_path: demoParent(entry.path, remote),
          };
          matches.push(item);
          batch.push(item);
          if (matches.length >= maxMatches) {
            truncated = true;
            break;
          }
        }
        if (
          entry.kind === "directory" &&
          !DEMO_SKIP_DIRECTORIES.has(entry.name.toLowerCase())
        ) {
          if (entry.name.toLowerCase().includes(needle)) preferred.push(entry.path);
          else other.push(entry.path);
        }
      }
      if (batch.length > 0) {
        callback({
          search_id: searchId,
          matches: batch,
          visited,
          truncated,
          done: false,
          cancelled: false,
        });
      }
      if (truncated) break;
      for (const path of other) queue.push({ path, depth: current.depth + 1 });
      for (const path of preferred.reverse()) {
        queue.unshift({ path, depth: current.depth + 1 });
      }
    }

    callback({
      search_id: searchId,
      matches: [],
      visited,
      truncated,
      done: true,
      cancelled: false,
    });
    demoSearchCancel.delete(searchId);
  });
  return searchId;
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
        ? demoList(localDemoTree, path)
        : [];
  },
  async listRemote(sessionId: UUID, path: string) {
    return desktop
      ? call<FileEntry[]>("list_remote_directory", { sessionId, path })
      : demoMode
        ? demoList(remoteDemoTree, path)
        : [];
  },
  async readLocalFile(path: string) {
    if (desktop) return call<EditableFile>("read_local_file", { path });
    return demoFile(path);
  },
  async readLocalPreview(path: string) {
    if (desktop) return call<PreviewFile>("read_local_preview", { path });
    return demoPreview(path);
  },
  async readLocalFilePrivileged(path: string, sudoPassword?: string) {
    if (desktop) return call<EditableFile>("read_local_file_privileged", { path, sudoPassword });
    return { ...demoFile(path), privileged: true };
  },
  async readRemoteFile(sessionId: UUID, path: string) {
    if (desktop) return call<EditableFile>("read_remote_file", { sessionId, path });
    return demoFile(path);
  },
  async readRemotePreview(sessionId: UUID, path: string) {
    if (desktop) return call<PreviewFile>("read_remote_preview", { sessionId, path });
    return demoPreview(path);
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
    if (demoMode) localDemoTree = demoAddEntry(localDemoTree, parentPath, name, directory);
  },
  async createLocalEntryPrivileged(parentPath: string, name: string, directory: boolean, sudoPassword?: string) {
    if (desktop) return call<void>("create_local_entry_privileged", { parentPath, name, directory, sudoPassword });
    if (demoMode) localDemoTree = demoAddEntry(localDemoTree, parentPath, name, directory);
  },
  async deleteLocalEntry(path: string, directory: boolean) {
    if (desktop) return call<void>("delete_local_entry", { path, directory });
    localDemoTree = demoRemoveEntry(localDemoTree, path);
  },
  async deleteLocalEntryPrivileged(path: string, directory: boolean, sudoPassword?: string) {
    if (desktop) return call<void>("delete_local_entry_privileged", { path, directory, sudoPassword });
    localDemoTree = demoRemoveEntry(localDemoTree, path);
  },
  async renameLocalEntry(from: string, to: string) {
    if (desktop) return call<void>("rename_local_entry", { from, to });
    localDemoTree = demoRenameEntry(localDemoTree, from, to);
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
    if (demoMode) remoteDemoTree = demoAddEntry(remoteDemoTree, parentPath, name, directory);
  },
  async createRemoteEntryPrivileged(sessionId: UUID, parentPath: string, name: string, directory: boolean, sudoPassword?: string) {
    if (desktop) return call<void>("create_remote_entry_privileged", { sessionId, parentPath, name, directory, sudoPassword });
    if (demoMode) remoteDemoTree = demoAddEntry(remoteDemoTree, parentPath, name, directory);
  },
  async renameRemoteEntry(sessionId: UUID, from: string, to: string) {
    if (desktop) return call<void>("rename_remote_entry", { sessionId, from, to });
    remoteDemoTree = demoRenameEntry(remoteDemoTree, from, to);
  },
  async deleteRemoteEntry(sessionId: UUID, path: string, directory: boolean) {
    if (desktop) return call<void>("delete_remote_entry", { sessionId, path, directory });
    remoteDemoTree = demoRemoveEntry(remoteDemoTree, path);
  },
  async deleteRemoteEntryPrivileged(sessionId: UUID, path: string, directory: boolean, sudoPassword?: string) {
    if (desktop) return call<void>("delete_remote_entry_privileged", { sessionId, path, directory, sudoPassword });
    remoteDemoTree = demoRemoveEntry(remoteDemoTree, path);
  },
  async setLocalPermissions(path: string, permissions: number) {
    if (desktop) return call<void>("set_local_permissions", { path, permissions });
    localDemoTree = demoUpdatePermissions(localDemoTree, path, permissions);
  },
  async setRemotePermissions(sessionId: UUID, path: string, permissions: number) {
    if (desktop) return call<void>("set_remote_permissions", { sessionId, path, permissions });
    remoteDemoTree = demoUpdatePermissions(remoteDemoTree, path, permissions);
  },
  async getLocalDirectorySize(path: string) {
    if (desktop) return call<number>("get_local_directory_size", { path });
    return demoAllFiles(localDemoTree, path).reduce((sum, entry) => sum + (entry.size ?? 0), 0);
  },
  async getRemoteDirectorySize(sessionId: UUID, path: string) {
    if (desktop) return call<number>("get_remote_directory_size", { sessionId, path });
    void sessionId;
    return demoAllFiles(remoteDemoTree, path).reduce((sum, entry) => sum + (entry.size ?? 0), 0);
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
  async enqueueDirectoryTransfer(draft: {
    profileId: UUID;
    direction: TransferDirection;
    sourcePath: string;
    destinationPath: string;
    conflictPolicy?: ConflictPolicy;
    mode: DirectoryTransferMode;
  }) {
    if (desktop) return call<TransferJob[]>("enqueue_directory_transfer", { draft });
    const files = demoAllFiles(
      draft.direction === "upload" ? localDemoTree : remoteDemoTree,
      draft.sourcePath,
    );
    const rootName = draft.sourcePath.split(/[\\/]/).filter(Boolean).pop() ?? "folder";
    if (files.length === 0) {
      throw {
        code: "invalid_input",
        message: "No files or folders found to transfer",
        retryable: false,
      } satisfies AppError;
    }
    const jobs = files.map((file) => {
      const relative =
        draft.mode === "include_root" ? `${rootName}/${file.name}` : file.name;
      const job = mockTransfer(relative, 0, draft.direction, "queued");
      job.source_path =
        draft.direction === "upload"
          ? `${draft.sourcePath.replace(/\/+$/, "")}/${file.name}`
          : file.path;
      job.destination_path = `${draft.destinationPath.replace(/\/+$/, "")}/${relative}`;
      job.partial_path = `${job.destination_path}.part`;
      return job;
    });
    browserTransfers = [...jobs, ...browserTransfers];
    return jobs;
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
      expand_transfers_on_new: true,
      connect_timeout_seconds: 15,
      response_timeout_seconds: 30,
      keepalive_seconds: 30,
      bookmark_order: {},
    } satisfies Preferences;
  },
  savePreferences(preferences: Preferences) {
    return desktop ? call<void>("save_preferences", { preferences }) : Promise.resolve();
  },
  async onTransferProgress(callback: (progress: TransferProgress) => void): Promise<UnlistenFn> {
    if (!desktop) return () => undefined;
    return listen<TransferProgress>("transfer-progress", ({ payload }) => callback(payload));
  },
  async listSavedActions() {
    return desktop ? call<SavedAction[]>("list_saved_actions") : browserSavedActions;
  },
  async saveSavedAction(action: SavedAction) {
    if (desktop) return call<SavedAction>("save_saved_action", { action });
    browserSavedActions = [
      ...browserSavedActions.filter((item) => item.id !== action.id),
      action,
    ].sort((left, right) => left.label.localeCompare(right.label));
    return action;
  },
  async deleteSavedAction(id: UUID) {
    if (desktop) return call<void>("delete_saved_action", { id });
    browserSavedActions = browserSavedActions.filter((action) => action.id !== id);
  },
  async listFavorites() {
    return desktop ? call<Favorite[]>("list_favorites") : browserFavorites;
  },
  async saveFavorite(favorite: Favorite) {
    if (desktop) return call<Favorite>("save_favorite", { favorite });
    if (!favorite.profile_id) {
      throw {
        code: "invalid_input",
        message: "Bookmarks must belong to a connection",
        retryable: false,
      } satisfies AppError;
    }
    const normalizedPath =
      favorite.side === "remote"
        ? `/${favorite.path
            .split("/")
            .filter((segment) => segment && segment !== ".")
            .join("/")}`
        : favorite.path.replace(/[\\/]+$/, "") || favorite.path;
    const existing = browserFavorites.find(
      (item) =>
        item.profile_id === favorite.profile_id &&
        item.side === favorite.side &&
        item.path === normalizedPath,
    );
    const saved = {
      ...favorite,
      id: existing?.id ?? favorite.id,
      path: normalizedPath,
      label: favorite.label.trim() || favorite.label,
    };
    browserFavorites = [
      ...browserFavorites.filter((item) => item.id !== saved.id),
      saved,
    ].sort((left, right) => left.label.localeCompare(right.label));
    return saved;
  },
  async deleteFavorite(id: UUID) {
    if (desktop) return call<void>("delete_favorite", { id });
    browserFavorites = browserFavorites.filter((favorite) => favorite.id !== id);
  },
  async packageLocalDirectory(path: string, format: ArchiveFormat = "zip") {
    if (desktop) return call<string>("package_local_directory", { path, format });
    return `${path.replace(/\/+$/, "")}.${format === "tar_gz" ? "tar.gz" : format}`;
  },
  async packageRemoteDirectory(
    sessionId: UUID,
    path: string,
    format: ArchiveFormat = "tar_gz",
  ) {
    if (desktop) return call<string>("package_remote_directory", { sessionId, path, format });
    void sessionId;
    return `${path.replace(/\/+$/, "") || "/"}.${format === "tar_gz" ? "tar.gz" : format}`;
  },
  async startSearchLocal(root: string, query: string) {
    if (desktop) return call<UUID>("start_search_local", { root, query });
    return runDemoSearch(localDemoTree, root, query, false);
  },
  async startSearchRemote(sessionId: UUID, root: string, query: string) {
    if (desktop) return call<UUID>("start_search_remote", { sessionId, root, query });
    void sessionId;
    return runDemoSearch(remoteDemoTree, root, query, true);
  },
  async cancelSearch(searchId: UUID) {
    if (desktop) return call<void>("cancel_search", { searchId });
    demoSearchCancel.set(searchId, true);
  },
  async onSearchProgress(callback: (progress: SearchProgress) => void): Promise<UnlistenFn> {
    if (desktop) {
      return listen<SearchProgress>("search-progress", ({ payload }) => callback(payload));
    }
    demoSearchListeners.add(callback);
    return () => {
      demoSearchListeners.delete(callback);
    };
  },
};

function demoFile(path: string): EditableFile {
  const name = path.split(/[\\/]/).pop() ?? "file.txt";
  const content = name.endsWith(".html")
    ? `<!doctype html>\n<html>\n  <head><title>Preview</title></head>\n  <body>\n    <h1>Edit this remote file</h1>\n  </body>\n</html>\n`
    : name.endsWith(".css") ? `body {\n  color: #202827;\n}\n` : `# ${name}\n\nEdit this file and save it back to the server.\n`;
  return { path, name, content, language: languageFor(name), size: new TextEncoder().encode(content).length, privileged: false };
}

function demoPreview(path: string): PreviewFile {
  const name = path.split(/[\\/]/).pop() ?? "preview.png";
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mNk+M9Qz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC";
  return {
    path,
    name,
    mime: name.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg",
    data_base64: png,
    size: 68,
  };
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
