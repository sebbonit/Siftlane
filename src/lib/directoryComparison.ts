import type { ComparisonStatus, FileEntry, SyncMode } from "../types";

export interface ComparedEntry {
  name: string;
  local: FileEntry | null;
  remote: FileEntry | null;
  status: ComparisonStatus;
}

export interface SyncAction {
  kind: "upload" | "download" | "delete_local" | "delete_remote";
  entry: FileEntry;
  reason: ComparisonStatus;
}

export function compareDirectories(local: FileEntry[], remote: FileEntry[]): ComparedEntry[] {
  const names = new Set([...local.map((entry) => entry.name), ...remote.map((entry) => entry.name)]);
  return [...names].sort().map((name) => {
    const localEntry = local.find((entry) => entry.name === name) ?? null;
    const remoteEntry = remote.find((entry) => entry.name === name) ?? null;
    return { name, local: localEntry, remote: remoteEntry, status: comparisonStatus(localEntry, remoteEntry) };
  });
}

export function comparisonStatus(local: FileEntry | null, remote: FileEntry | null): ComparisonStatus {
  if (!local) return "remote_only";
  if (!remote) return "local_only";
  if (local.kind !== remote.kind || local.size !== remote.size) return "size_mismatch";
  const localTime = local.modified_at ? Date.parse(local.modified_at) : 0;
  const remoteTime = remote.modified_at ? Date.parse(remote.modified_at) : 0;
  if (Math.abs(localTime - remoteTime) < 2_000) return "same";
  return localTime > remoteTime ? "local_newer" : "remote_newer";
}

export function planSynchronization(entries: ComparedEntry[], mode: SyncMode): SyncAction[] {
  const actions: SyncAction[] = [];
  for (const item of entries) {
    if (item.status === "same") continue;
    if (mode === "upload_mirror") {
      if (item.local) actions.push({ kind: "upload", entry: item.local, reason: item.status });
      else if (item.remote) actions.push({ kind: "delete_remote", entry: item.remote, reason: item.status });
    } else if (mode === "download_mirror") {
      if (item.remote) actions.push({ kind: "download", entry: item.remote, reason: item.status });
      else if (item.local) actions.push({ kind: "delete_local", entry: item.local, reason: item.status });
    } else if (item.local && !item.remote) {
      actions.push({ kind: "upload", entry: item.local, reason: item.status });
    } else if (item.remote && !item.local) {
      actions.push({ kind: "download", entry: item.remote, reason: item.status });
    } else if (item.local && item.remote) {
      const localTime = item.local.modified_at ? Date.parse(item.local.modified_at) : 0;
      const remoteTime = item.remote.modified_at ? Date.parse(item.remote.modified_at) : 0;
      const remoteWins = item.status === "remote_newer" || (
        item.status === "size_mismatch" && remoteTime > localTime
      );
      actions.push({
        kind: remoteWins ? "download" : "upload",
        entry: remoteWins ? item.remote : item.local,
        reason: item.status,
      });
    }
  }
  return actions;
}
