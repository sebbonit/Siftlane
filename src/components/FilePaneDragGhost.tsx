import { useSyncExternalStore } from "react";
import { ArrowDownToLine, ArrowUpFromLine, File, Folder, FolderInput } from "lucide-react";
import {
  getFilePaneDragState,
  subscribeFilePaneDrag,
} from "../lib/filePaneDnD";

export function FilePaneDragGhost() {
  const state = useSyncExternalStore(subscribeFilePaneDrag, getFilePaneDragState, () => null);
  if (!state) return null;

  const { payload, clientX, clientY, dropSide, dropMode } = state;
  const canDrop = dropSide != null && dropMode != null;
  const Icon = payload.entry.kind === "directory" ? Folder : File;
  const action =
    dropMode === "move"
      ? { label: "Move", ActionIcon: FolderInput }
      : payload.side === "local"
        ? { label: "Upload", ActionIcon: ArrowUpFromLine }
        : { label: "Download", ActionIcon: ArrowDownToLine };
  const ActionIcon = action.ActionIcon;

  return (
    <div
      className={`file-pane-drag-ghost${canDrop ? " can-drop" : " is-idle"}`}
      style={{ transform: `translate3d(${clientX + 14}px, ${clientY + 14}px, 0)` }}
      aria-hidden
    >
      <span className="file-pane-drag-ghost-icon">
        <Icon size={15} />
      </span>
      <span className="file-pane-drag-ghost-name">{payload.entry.name}</span>
      {canDrop && (
        <span className="file-pane-drag-ghost-action">
          <ActionIcon size={11} />
          {action.label}
        </span>
      )}
    </div>
  );
}
