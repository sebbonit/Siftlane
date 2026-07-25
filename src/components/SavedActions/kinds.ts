import type { ArchiveFormat, SavedActionKind } from "../../types";

export const ARCHIVE_FORMATS: Array<{
  value: ArchiveFormat;
  label: string;
}> = [
  { value: "zip", label: "ZIP (.zip)" },
  { value: "tar", label: "TAR (.tar)" },
  { value: "tar_gz", label: "TAR.GZ (.tar.gz)" },
];

export const SAVED_ACTION_KINDS: Array<{
  kind: SavedActionKind;
  label: string;
  description: string;
  needsLocal: boolean;
  needsRemote: boolean;
  needsArchiveFormat: boolean;
  needsCommands: boolean;
  optionalRemote: boolean;
}> = [
  {
    kind: "open_both",
    label: "Open local + remote",
    description: "Navigate both panes to saved directories",
    needsLocal: true,
    needsRemote: true,
    needsArchiveFormat: false,
    needsCommands: false,
    optionalRemote: false,
  },
  {
    kind: "open_local",
    label: "Open local directory",
    description: "Navigate the local pane to a directory",
    needsLocal: true,
    needsRemote: false,
    needsArchiveFormat: false,
    needsCommands: false,
    optionalRemote: false,
  },
  {
    kind: "open_remote",
    label: "Open remote directory",
    description: "Navigate the remote pane to a directory",
    needsLocal: false,
    needsRemote: true,
    needsArchiveFormat: false,
    needsCommands: false,
    optionalRemote: false,
  },
  {
    kind: "upload_dir",
    label: "Upload directory",
    description: "Recursively upload a local directory into a remote directory",
    needsLocal: true,
    needsRemote: true,
    needsArchiveFormat: false,
    needsCommands: false,
    optionalRemote: false,
  },
  {
    kind: "download_dir",
    label: "Download directory",
    description: "Recursively download a remote directory into a local directory",
    needsLocal: true,
    needsRemote: true,
    needsArchiveFormat: false,
    needsCommands: false,
    optionalRemote: false,
  },
  {
    kind: "package_local",
    label: "Package local directory",
    description: "Create an archive of a local directory next to it",
    needsLocal: true,
    needsRemote: false,
    needsArchiveFormat: true,
    needsCommands: false,
    optionalRemote: false,
  },
  {
    kind: "package_remote",
    label: "Package remote directory",
    description: "Create an archive of a remote directory next to it (SFTP)",
    needsLocal: false,
    needsRemote: true,
    needsArchiveFormat: true,
    needsCommands: false,
    optionalRemote: false,
  },
  {
    kind: "package_and_download",
    label: "Package and download",
    description: "Archive a remote directory, then download it to a local folder (SFTP)",
    needsLocal: true,
    needsRemote: true,
    needsArchiveFormat: true,
    needsCommands: false,
    optionalRemote: false,
  },
  {
    kind: "run_remote_commands",
    label: "Run remote commands",
    description:
      "Run a series of SSH commands on the connected remote (SFTP). Stops on the first failure.",
    needsLocal: false,
    needsRemote: false,
    needsArchiveFormat: false,
    needsCommands: true,
    optionalRemote: true,
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

export function actionNeedsArchiveFormat(kind: SavedActionKind): boolean {
  return SAVED_ACTION_KINDS.find((item) => item.kind === kind)?.needsArchiveFormat ?? false;
}

export function actionNeedsCommands(kind: SavedActionKind): boolean {
  return SAVED_ACTION_KINDS.find((item) => item.kind === kind)?.needsCommands ?? false;
}

export function actionOptionalRemote(kind: SavedActionKind): boolean {
  return SAVED_ACTION_KINDS.find((item) => item.kind === kind)?.optionalRemote ?? false;
}

export function defaultArchiveFormat(kind: SavedActionKind): ArchiveFormat {
  return kind === "package_local" ? "zip" : "tar_gz";
}

export function archiveExtension(format: ArchiveFormat): string {
  switch (format) {
    case "zip":
      return "zip";
    case "tar":
      return "tar";
    case "tar_gz":
      return "tar.gz";
  }
}

export function parseCommandLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
