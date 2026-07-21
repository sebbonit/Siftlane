import {
  FileEdit,
  FilePlus2,
  FolderOpen,
  FolderPlus,
  Info,
  LockKeyhole,
  Trash2,
} from "lucide-react";
import { fileManagerRevealLabel } from "../lib/platform";
import type { FileEntry } from "../types";
import { ContextMenu } from "./ContextMenu";

export function FilePaneContextMenu({
  x,
  y,
  path,
  entry,
  onClose,
  onOpenFile,
  onOpenPrivileged,
  onCreateFile,
  onCreateFilePrivileged,
  onCreateDirectory,
  onCreateDirectoryPrivileged,
  onShowInfo,
  onRemove,
  onRemovePrivileged,
  onRevealInFileManager,
}: {
  x: number;
  y: number;
  path: string;
  entry: FileEntry | null;
  onClose: () => void;
  onOpenFile: (entry: FileEntry) => void;
  onOpenPrivileged: (entry: FileEntry) => void;
  onCreateFile: () => void;
  onCreateFilePrivileged: () => void;
  onCreateDirectory: () => void;
  onCreateDirectoryPrivileged: () => void;
  onShowInfo: (entry: FileEntry) => void;
  onRemove: (entry: FileEntry) => void;
  onRemovePrivileged: (entry: FileEntry) => void;
  onRevealInFileManager?: (path: string) => void;
}) {
  function run(action: () => void) {
    onClose();
    action();
  }

  return (
    <ContextMenu x={x} y={y} onClose={onClose}>
      {entry?.kind === "file" && (
        <>
          <button onClick={() => run(() => onOpenFile(entry))}>
            <FileEdit size={14} />
            Edit file
          </button>
          <button onClick={() => run(() => onOpenPrivileged(entry))}>
            <LockKeyhole size={14} />
            Edit with sudo
          </button>
          <i />
        </>
      )}
      {onRevealInFileManager && (
        <>
          <button onClick={() => run(() => onRevealInFileManager(entry?.path ?? path))}>
            <FolderOpen size={14} />
            {fileManagerRevealLabel()}
          </button>
          <i />
        </>
      )}
      <button onClick={() => run(onCreateFile)}>
        <FilePlus2 size={14} />
        New file
      </button>
      <button onClick={() => run(onCreateFilePrivileged)}>
        <LockKeyhole size={14} />
        New file with sudo
      </button>
      <button onClick={() => run(onCreateDirectory)}>
        <FolderPlus size={14} />
        New folder
      </button>
      <button onClick={() => run(onCreateDirectoryPrivileged)}>
        <LockKeyhole size={14} />
        New folder with sudo
      </button>
      {entry && (
        <>
          <i />
          <button onClick={() => run(() => onShowInfo(entry))}>
            <Info size={14} />
            Get Info
          </button>
          <i />
          <button onClick={() => run(() => onRemove(entry))}>
            <Trash2 size={14} />
            Delete
          </button>
          <button className="danger" onClick={() => run(() => onRemovePrivileged(entry))}>
            <LockKeyhole size={14} />
            Delete with sudo
          </button>
        </>
      )}
    </ContextMenu>
  );
}
