import { useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  cancelFilePaneDrag,
  endFilePaneDrag,
  getFilePaneDragState,
  isTransferableEntry,
  moveFilePaneDrag,
  startFilePaneDrag,
  subscribeFilePaneDrag,
  type DropMode,
  type PaneSide,
} from "../lib/filePaneDnD";
import type { FileEntry } from "../types";

const DRAG_THRESHOLD_PX = 4;

export type PaneDropHandler = (args: {
  entry: FileEntry;
  sourceSide: PaneSide;
  destinationSide: PaneSide;
  destinationPath: string;
  mode: DropMode;
}) => void;

export function useFilePaneDnD(
  side: PaneSide,
  onSelect: (entry: FileEntry) => void,
  onPaneDrop?: PaneDropHandler,
) {
  const [dragOverPane, setDragOverPane] = useState(false);
  const [dragOverFolderPath, setDragOverFolderPath] = useState<string | null>(null);
  const [draggingPath, setDraggingPath] = useState<string | null>(null);

  useEffect(() => {
    return subscribeFilePaneDrag(() => {
      const state = getFilePaneDragState();
      setDraggingPath(state?.payload.entry.path ?? null);
      if (!state || state.dropSide !== side) {
        setDragOverPane(false);
        setDragOverFolderPath(null);
        return;
      }
      // Highlight the pane for transfers; for moves highlight when a folder is targeted.
      setDragOverPane(state.dropMode === "transfer" || !!state.dropFolderPath);
      setDragOverFolderPath(state.dropFolderPath);
    });
  }, [side]);

  function handleRowPointerDown(event: ReactPointerEvent, entry: FileEntry) {
    if (!onPaneDrop || event.button !== 0 || !isTransferableEntry(entry)) return;

    const originX = event.clientX;
    const originY = event.clientY;
    let dragging = false;
    const pointerId = event.pointerId;

    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      document.body.classList.remove("is-file-pane-dragging");
    };

    const onMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      const dx = moveEvent.clientX - originX;
      const dy = moveEvent.clientY - originY;
      if (!dragging) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        dragging = true;
        onSelect(entry);
        startFilePaneDrag({ side, entry }, moveEvent.clientX, moveEvent.clientY);
        document.body.classList.add("is-file-pane-dragging");
        try {
          event.currentTarget.setPointerCapture(pointerId);
        } catch {
          // Capture is best-effort; window listeners still track the drag.
        }
      }
      moveEvent.preventDefault();
      moveFilePaneDrag(moveEvent.clientX, moveEvent.clientY);
    };

    const onUp = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== pointerId) return;
      cleanup();
      if (!dragging) return;

      const finished = endFilePaneDrag();
      if (!finished?.dropSide || !finished.dropMode || !onPaneDrop) return;

      const paneEl = document.querySelector<HTMLElement>(
        `[data-pane-side="${finished.dropSide}"]`,
      );
      const destinationPath =
        finished.dropMode === "move"
          ? finished.dropFolderPath
          : finished.dropFolderPath || paneEl?.dataset.panePath;
      if (!destinationPath) return;

      onPaneDrop({
        entry: finished.payload.entry,
        sourceSide: finished.payload.side,
        destinationSide: finished.dropSide,
        destinationPath,
        mode: finished.dropMode,
      });
    };

    const onCancel = (cancelEvent: PointerEvent) => {
      if (cancelEvent.pointerId !== pointerId) return;
      cleanup();
      cancelFilePaneDrag();
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  }

  return {
    dragOverPane,
    dragOverFolderPath,
    draggingPath,
    handleRowPointerDown,
  };
}
