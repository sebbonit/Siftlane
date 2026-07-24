import { afterEach, describe, expect, it } from "vitest";
import type { FileEntry } from "../types";
import {
  cancelFilePaneDrag,
  canMoveIntoFolder,
  endFilePaneDrag,
  getFilePaneDragState,
  isCrossPaneDrop,
  isTransferableEntry,
  moveFilePaneDrag,
  resolveDropDestination,
  resolveDropTargetAtPoint,
  startFilePaneDrag,
  transferDirectionForDrop,
} from "./filePaneDnD";

function entry(partial: Partial<FileEntry> & Pick<FileEntry, "path" | "name" | "kind">): FileEntry {
  return {
    size: null,
    modified_at: null,
    permissions: null,
    symlink_target: null,
    hidden: false,
    ...partial,
  };
}

afterEach(() => {
  cancelFilePaneDrag();
});

describe("filePaneDnD", () => {
  it("tracks an in-memory pointer drag and clears on end", () => {
    const payload = {
      side: "local" as const,
      entry: entry({ path: "/tmp/a.txt", name: "a.txt", kind: "file" }),
    };
    startFilePaneDrag(payload, 10, 20);
    expect(getFilePaneDragState()?.payload).toEqual(payload);
    expect(getFilePaneDragState()?.clientX).toBe(10);

    const finished = endFilePaneDrag();
    expect(finished?.payload).toEqual(payload);
    expect(getFilePaneDragState()).toBeNull();
  });

  it("only allows opposite-pane drops and maps direction from source side", () => {
    expect(isCrossPaneDrop("local", "remote")).toBe(true);
    expect(isCrossPaneDrop("remote", "local")).toBe(true);
    expect(isCrossPaneDrop("local", "local")).toBe(false);
    expect(transferDirectionForDrop("local")).toBe("upload");
    expect(transferDirectionForDrop("remote")).toBe("download");
    expect(isTransferableEntry(entry({ path: "/x", name: "x", kind: "symlink" }))).toBe(false);
  });

  it("resolves drop destination to a folder path or the pane path", () => {
    expect(resolveDropDestination("/home/user", "/var/www")).toBe("/var/www");
    expect(resolveDropDestination("/home/user", null)).toBe("/home/user");
  });

  it("rejects invalid same-pane move targets", () => {
    const folder = entry({ path: "/home/docs", name: "docs", kind: "directory" });
    const nested = entry({ path: "/home/docs/notes", name: "notes", kind: "directory" });
    const file = entry({ path: "/home/docs/a.txt", name: "a.txt", kind: "file" });
    expect(canMoveIntoFolder(folder, "/home/docs", true)).toBe(false);
    expect(canMoveIntoFolder(folder, "/home/docs/notes", true)).toBe(false);
    expect(canMoveIntoFolder(file, "/home/docs", true)).toBe(false);
    expect(canMoveIntoFolder(file, "/home/other", true)).toBe(true);
    expect(canMoveIntoFolder(nested, "/home", true)).toBe(true);
  });

  it("resolves cross-pane transfer and same-pane move targets from DOM", () => {
    const remote = document.createElement("section");
    remote.dataset.paneSide = "remote";
    remote.dataset.panePath = "/var/www";
    const folder = document.createElement("button");
    folder.dataset.dropFolder = "/var/www/html";
    remote.appendChild(folder);
    document.body.appendChild(remote);

    const local = document.createElement("section");
    local.dataset.paneSide = "local";
    local.dataset.panePath = "/home";
    const localFolder = document.createElement("button");
    localFolder.dataset.dropFolder = "/home/docs";
    local.appendChild(localFolder);
    document.body.appendChild(local);

    document.elementFromPoint = () => folder;
    expect(
      resolveDropTargetAtPoint(
        5,
        5,
        "local",
        entry({ path: "/tmp/a.txt", name: "a.txt", kind: "file" }),
      ),
    ).toEqual({ side: "remote", folderPath: "/var/www/html", mode: "transfer" });

    document.elementFromPoint = () => localFolder;
    startFilePaneDrag(
      {
        side: "local",
        entry: entry({ path: "/home/a.txt", name: "a.txt", kind: "file" }),
      },
      1,
      1,
    );
    moveFilePaneDrag(5, 5);
    expect(getFilePaneDragState()?.dropMode).toBe("move");
    expect(getFilePaneDragState()?.dropFolderPath).toBe("/home/docs");

    remote.remove();
    local.remove();
  });
});
