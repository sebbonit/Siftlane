import {
  File,
  FileCode2,
  Folder,
  Image as ImageIcon,
  LoaderCircle,
} from "lucide-react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { formatBytes, formatDate, formatPermissions } from "../lib/format";
import { isTransferableEntry } from "../lib/filePaneDnD";
import { isImageFile } from "../lib/media";
import type { ComparisonStatus, FileEntry } from "../types";

export function FilePaneRows({
  loading,
  entriesEmpty,
  visible,
  selectedPaths,
  comparisonByName,
  dragOverFolderPath,
  draggingPath,
  onSelect,
  onNavigate,
  onOpenFile,
  onContextMenu,
  onPointerDownRow,
}: {
  loading: boolean;
  entriesEmpty: boolean;
  visible: FileEntry[];
  selectedPaths: Set<string>;
  comparisonByName?: Record<string, ComparisonStatus>;
  dragOverFolderPath: string | null;
  draggingPath: string | null;
  onSelect: (entry: FileEntry, event: ReactMouseEvent) => void;
  onNavigate: (path: string) => void;
  onOpenFile: (entry: FileEntry) => void;
  onContextMenu: (event: ReactMouseEvent, entry: FileEntry) => void;
  onPointerDownRow: (event: ReactPointerEvent, entry: FileEntry) => void;
}) {
  if (loading && entriesEmpty) {
    return (
      <div className="pane-message">
        <LoaderCircle className="spin" size={20} /> Loading directory…
      </div>
    );
  }

  return (
    <>
      {visible.map((entry) => {
        const comparison = comparisonByName?.[entry.name];
        const transferable = isTransferableEntry(entry);
        const isFolderDropTarget =
          entry.kind === "directory" && dragOverFolderPath === entry.path;
        const isDragging = draggingPath === entry.path;
        return (
          <button
            key={entry.path}
            type="button"
            data-drop-folder={entry.kind === "directory" ? entry.path : undefined}
            className={`file-row${selectedPaths.has(entry.path) ? " selected" : ""}${isFolderDropTarget ? " is-drop-target" : ""}${transferable ? " is-draggable" : ""}${isDragging ? " is-dragging" : ""}${comparison && comparison !== "same" ? ` comparison-${comparison}` : ""}`}
            onClick={(event) => onSelect(entry, event)}
            onDoubleClick={() =>
              entry.kind === "directory" ? onNavigate(entry.path) : onOpenFile(entry)
            }
            onContextMenu={(event) => {
              event.stopPropagation();
              onSelect(entry, event);
              onContextMenu(event, entry);
            }}
            onPointerDown={(event) => onPointerDownRow(event, entry)}
            role="row"
          >
            <span className="file-name">
              {fileIcon(entry)}
              <span>{entry.name}</span>
              {comparison && comparison !== "same" && (
                <em className="comparison-badge">
                  {comparison.replaceAll("_", " ")}
                </em>
              )}
              {entry.kind === "symlink" && <small>→ {entry.symlink_target}</small>}
            </span>
            <span className="file-size">
              {entry.kind === "directory" && entry.size == null ? "—" : formatBytes(entry.size)}
            </span>
            <span className="file-modified">{formatDate(entry.modified_at)}</span>
            <span className="permissions">{formatPermissions(entry.permissions)}</span>
          </button>
        );
      })}
      {!loading && visible.length === 0 && <div className="pane-message">No matching files</div>}
    </>
  );
}

function fileIcon(entry: FileEntry) {
  if (entry.kind === "directory") return <Folder size={17} fill="currentColor" />;
  if (isImageFile(entry.name)) return <ImageIcon size={16} />;
  if (/\.(tsx?|jsx?|html|css|json|rs)$/i.test(entry.name)) return <FileCode2 size={16} />;
  return <File size={16} />;
}
