import type { FileEntry } from "../types";
import { parentPath } from "./paths";

export type PaneSide = "local" | "remote";

export type DropMode = "transfer" | "move";

export interface FilePaneDragPayload {
  side: PaneSide;
  entry: FileEntry;
}

export interface FilePaneDropTarget {
  side: PaneSide;
  folderPath: string | null;
  mode: DropMode;
}

export interface FilePaneDragState {
  payload: FilePaneDragPayload;
  clientX: number;
  clientY: number;
  dropSide: PaneSide | null;
  dropFolderPath: string | null;
  dropMode: DropMode | null;
}

type Listener = () => void;

let dragState: FilePaneDragState | null = null;
const listeners = new Set<Listener>();

function emit() {
  for (const listener of listeners) listener();
}

export function subscribeFilePaneDrag(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getFilePaneDragState(): FilePaneDragState | null {
  return dragState;
}

export function isTransferableEntry(entry: FileEntry): boolean {
  return entry.kind === "file" || entry.kind === "directory";
}

export function isCrossPaneDrop(
  sourceSide: PaneSide,
  destinationSide: PaneSide,
): boolean {
  return sourceSide !== destinationSide;
}

export function transferDirectionForDrop(
  sourceSide: PaneSide,
): "upload" | "download" {
  return sourceSide === "local" ? "upload" : "download";
}

export function resolveDropDestination(
  panePath: string,
  dropFolderPath: string | null | undefined,
): string {
  return dropFolderPath || panePath;
}

/** True when source can be moved into destinationFolder on the same pane. */
export function canMoveIntoFolder(
  source: FileEntry,
  destinationFolder: string,
  remote: boolean,
): boolean {
  if (!destinationFolder || source.path === destinationFolder) return false;
  if (parentPath(source.path, remote) === destinationFolder) return false;
  if (source.kind === "directory") {
    const separator = remote || !source.path.includes("\\") ? "/" : "\\";
    const prefix = source.path.endsWith(separator)
      ? source.path
      : `${source.path}${separator}`;
    if (destinationFolder === source.path || destinationFolder.startsWith(prefix)) {
      return false;
    }
  }
  return true;
}

export function startFilePaneDrag(
  payload: FilePaneDragPayload,
  clientX: number,
  clientY: number,
): void {
  dragState = {
    payload,
    clientX,
    clientY,
    dropSide: null,
    dropFolderPath: null,
    dropMode: null,
  };
  emit();
}

export function moveFilePaneDrag(clientX: number, clientY: number): void {
  if (!dragState) return;
  const target = resolveDropTargetAtPoint(
    clientX,
    clientY,
    dragState.payload.side,
    dragState.payload.entry,
  );
  dragState = {
    ...dragState,
    clientX,
    clientY,
    dropSide: target?.side ?? null,
    dropFolderPath: target?.folderPath ?? null,
    dropMode: target?.mode ?? null,
  };
  emit();
}

export function endFilePaneDrag(): FilePaneDragState | null {
  const finished = dragState;
  dragState = null;
  emit();
  return finished;
}

export function cancelFilePaneDrag(): void {
  if (!dragState) return;
  dragState = null;
  emit();
}

export function resolveDropTargetAtPoint(
  clientX: number,
  clientY: number,
  sourceSide: PaneSide,
  sourceEntry: FileEntry,
): FilePaneDropTarget | null {
  const el = document.elementFromPoint(clientX, clientY);
  if (!(el instanceof Element)) return null;

  const pane = el.closest<HTMLElement>("[data-pane-side]");
  const side = pane?.dataset.paneSide;
  if (side !== "local" && side !== "remote") return null;

  const folder = el.closest<HTMLElement>("[data-drop-folder]");
  const folderPath = folder?.dataset.dropFolder || null;

  if (isCrossPaneDrop(sourceSide, side)) {
    return { side, folderPath, mode: "transfer" };
  }

  // Same-pane moves only land on a different folder row.
  if (!folderPath) return null;
  if (!canMoveIntoFolder(sourceEntry, folderPath, side === "remote")) return null;
  return { side, folderPath, mode: "move" };
}
