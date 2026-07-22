import type { SavedActionKind } from "../../types";

export const SAVED_ACTION_KINDS: Array<{
  kind: SavedActionKind;
  label: string;
  description: string;
  needsLocal: boolean;
  needsRemote: boolean;
}> = [
  {
    kind: "open_both",
    label: "Open local + remote",
    description: "Navigate both panes to saved directories",
    needsLocal: true,
    needsRemote: true,
  },
  {
    kind: "open_local",
    label: "Open local directory",
    description: "Navigate the local pane to a directory",
    needsLocal: true,
    needsRemote: false,
  },
  {
    kind: "open_remote",
    label: "Open remote directory",
    description: "Navigate the remote pane to a directory",
    needsLocal: false,
    needsRemote: true,
  },
  {
    kind: "upload_dir",
    label: "Upload directory files",
    description: "Upload files from a local directory to a remote directory",
    needsLocal: true,
    needsRemote: true,
  },
  {
    kind: "download_dir",
    label: "Download directory files",
    description: "Download files from a remote directory to a local directory",
    needsLocal: true,
    needsRemote: true,
  },
  {
    kind: "package_local",
    label: "Package local directory",
    description: "Create a zip archive of a local directory",
    needsLocal: true,
    needsRemote: false,
  },
  {
    kind: "package_remote",
    label: "Package remote directory",
    description: "Create a tar.gz archive of a remote directory (SFTP)",
    needsLocal: false,
    needsRemote: true,
  },
];

export function savedActionKindLabel(kind: SavedActionKind): string {
  return SAVED_ACTION_KINDS.find((item) => item.kind === kind)?.label ?? kind;
}

export function actionNeedsLocal(kind: SavedActionKind): boolean {
  return SAVED_ACTION_KINDS.find((item) => item.kind === kind)?.needsLocal ?? false;
}

export function actionNeedsRemote(kind: SavedActionKind): boolean {
  return SAVED_ACTION_KINDS.find((item) => item.kind === kind)?.needsRemote ?? false;
}
