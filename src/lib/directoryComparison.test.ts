import { describe, expect, it } from "vitest";
import type { FileEntry } from "../types";
import { compareDirectories, planSynchronization } from "./directoryComparison";

function entry(name: string, size: number, modified: string): FileEntry {
  return {
    path: `/root/${name}`,
    name,
    kind: "file",
    size,
    modified_at: modified,
    permissions: 0o644,
    symlink_target: null,
    hidden: false,
  };
}

describe("directory comparison", () => {
  it("marks one-sided, newer, and size-mismatched entries", () => {
    const local = [
      entry("local.txt", 1, "2026-01-01T00:00:00Z"),
      entry("newer.txt", 2, "2026-01-02T00:00:00Z"),
      entry("size.txt", 3, "2026-01-01T00:00:00Z"),
    ];
    const remote = [
      entry("remote.txt", 1, "2026-01-01T00:00:00Z"),
      entry("newer.txt", 2, "2026-01-01T00:00:00Z"),
      entry("size.txt", 4, "2026-01-01T00:00:00Z"),
    ];
    expect(Object.fromEntries(compareDirectories(local, remote).map((item) => [item.name, item.status])))
      .toEqual({
        "local.txt": "local_only",
        "newer.txt": "local_newer",
        "remote.txt": "remote_only",
        "size.txt": "size_mismatch",
      });
  });

  it("plans mirror deletions but never hides them from review", () => {
    const compared = compareDirectories(
      [entry("local.txt", 1, "2026-01-01T00:00:00Z")],
      [entry("remote.txt", 1, "2026-01-01T00:00:00Z")],
    );
    expect(planSynchronization(compared, "upload_mirror").map((action) => action.kind))
      .toEqual(["upload", "delete_remote"]);
    expect(planSynchronization(compared, "two_way").map((action) => action.kind))
      .toEqual(["upload", "download"]);
  });
});
