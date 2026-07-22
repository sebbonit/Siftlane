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
}> = [
  {
    kind: "open_both",
    label: "Open local + remote",
    description: "Navigate both panes to saved directories",
    needsLocal: true,
    needsRemote: true,
    needsArchiveFormat: false,
  },
  {
    kind: "open_local",
    label: "Open local directory",
    description: "Navigate the local pane to a directory",
    needsLocal: true,
    needsRemote: false,
    needsArchiveFormat: false,
  },
  {
    kind: "open_remote",
    label: "Open remote directory",
    description: "Navigate the remote pane to a directory",
    needsLocal: false,
    needsRemote: true,
    needsArchiveFormat: false,
  },
  {
    kind: "upload_dir",
    label: "Upload directory files",
    description: "Upload files from a local directory to a remote directory",
    needsLocal: true,
    needsRemote: true,
    needsArchiveFormat: false,
  },
  {
    kind: "download_dir",
    label: "Download directory files",
    description: "Download files from a remote directory to a local directory",
    needsLocal: true,
    needsRemote: true,
    needsArchiveFormat: false,
  },
  {
    kind: "package_local",
    label: "Package local directory",
    description: "Create an archive of a local directory next to it",
    needsLocal: true,
    needsRemote: false,
    needsArchiveFormat: true,
  },
  {
    kind: "package_remote",
    label: "Package remote directory",
    description: "Create an archive of a remote directory next to it (SFTP)",
    needsLocal: false,
    needsRemote: true,
    needsArchiveFormat: true,
  },
  {
    kind: "package_and_download",
    label: "Package and download",
    description: "Archive a remote directory, then download it to a local folder (SFTP)",
    needsLocal: true,
    needsRemote: true,
    needsArchiveFormat: true,
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
