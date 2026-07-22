import { api } from "../../lib/ipc";
import { joinPath } from "../../lib/paths";
import type { SavedAction, SessionTab, TransferJob, UUID } from "../../types";

export type RunSavedActionResult = {
  message?: string;
  transfers?: TransferJob[];
  refreshLocal?: boolean;
  refreshRemote?: boolean;
};

export async function runSavedAction(
  action: SavedAction,
  context: {
    tab: SessionTab | null;
    navigate: (side: "local" | "remote", path: string) => Promise<void>;
  },
): Promise<RunSavedActionResult> {
  switch (action.kind) {
    case "open_local":
      await requireLocal(action, context.navigate);
      return {};
    case "open_remote":
      await requireRemote(action, context);
      return {};
    case "open_both":
      await requireLocal(action, context.navigate);
      await requireRemote(action, context);
      return {};
    case "upload_dir":
      return enqueueDirectoryTransfer(action, context, "upload");
    case "download_dir":
      return enqueueDirectoryTransfer(action, context, "download");
    case "package_local": {
      const localPath = requirePath(action.local_path, "local");
      const archive = await api.packageLocalDirectory(localPath);
      return {
        message: `Created ${archive}`,
        refreshLocal: true,
      };
    }
    case "package_remote": {
      const tab = requireTab(context.tab);
      const remotePath = requirePath(action.remote_path, "remote");
      const archive = await api.packageRemoteDirectory(tab.id, remotePath);
      return {
        message: `Created ${archive}`,
        refreshRemote: true,
      };
    }
  }
}

async function requireLocal(
  action: SavedAction,
  navigate: (side: "local" | "remote", path: string) => Promise<void>,
) {
  await navigate("local", requirePath(action.local_path, "local"));
}

async function requireRemote(
  action: SavedAction,
  context: {
    tab: SessionTab | null;
    navigate: (side: "local" | "remote", path: string) => Promise<void>;
  },
) {
  requireTab(context.tab);
  await context.navigate("remote", requirePath(action.remote_path, "remote"));
}

async function enqueueDirectoryTransfer(
  action: SavedAction,
  context: {
    tab: SessionTab | null;
    navigate: (side: "local" | "remote", path: string) => Promise<void>;
  },
  direction: "upload" | "download",
): Promise<RunSavedActionResult> {
  const tab = requireTab(context.tab);
  const localPath = requirePath(action.local_path, "local");
  const remotePath = requirePath(action.remote_path, "remote");
  await context.navigate("local", localPath);
  await context.navigate("remote", remotePath);

  const sourcePath = direction === "upload" ? localPath : remotePath;
  const destinationBase = direction === "upload" ? remotePath : localPath;
  const entries =
    direction === "upload"
      ? await api.listLocal(sourcePath)
      : await api.listRemote(tab.id, sourcePath);
  const files = entries.filter((entry) => entry.kind === "file");
  if (files.length === 0) {
    throw new Error("No files found in that directory to transfer");
  }

  const transfers: TransferJob[] = [];
  for (const file of files) {
    const job = await api.enqueueTransfer({
      profileId: tab.profileId,
      direction,
      sourcePath: file.path,
      destinationPath: joinPath(destinationBase, file.name, direction === "upload"),
      conflictPolicy: "ask",
    });
    transfers.push(job);
  }
  return {
    message: `Queued ${files.length} ${direction}${files.length === 1 ? "" : "s"}`,
    transfers,
  };
}

function requireTab(tab: SessionTab | null): SessionTab {
  if (!tab) throw new Error("Connect a session before running this action");
  return tab;
}

function requirePath(path: string | null, side: "local" | "remote"): string {
  if (!path?.trim()) throw new Error(`This action is missing a ${side} directory`);
  return path.trim();
}

export function newSavedActionId(): UUID {
  return crypto.randomUUID();
}
