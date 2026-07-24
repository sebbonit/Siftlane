import { describe, expect, it } from "vitest";
import type { Favorite } from "../types";
import {
  bookmarkIds,
  moveBookmarkId,
  orderBookmarks,
  orderForProfile,
  withProfileOrder,
} from "./bookmarkOrder";

function bookmark(partial: Partial<Favorite> & Pick<Favorite, "id" | "label" | "path">): Favorite {
  return {
    profile_id: "p1",
    side: "remote",
    ...partial,
  };
}

describe("orderBookmarks", () => {
  const items = [
    bookmark({ id: "a", label: "Alpha", path: "/a" }),
    bookmark({ id: "b", label: "Beta", path: "/b" }),
    bookmark({ id: "c", label: "Charlie", path: "/c" }),
  ];

  it("applies saved order and appends unknowns", () => {
    expect(orderBookmarks(items, ["c", "a"]).map((item) => item.id)).toEqual(["c", "a", "b"]);
  });

  it("falls back to label order when empty", () => {
    expect(orderBookmarks(items, []).map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  it("ignores stale ids", () => {
    expect(orderBookmarks(items, ["gone", "b", "a"]).map((item) => item.id)).toEqual([
      "b",
      "a",
      "c",
    ]);
  });
});

describe("moveBookmarkId", () => {
  it("moves an id to another slot", () => {
    expect(moveBookmarkId(["a", "b", "c"], "a", "c")).toEqual(["b", "c", "a"]);
    expect(moveBookmarkId(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
    expect(moveBookmarkId(["a", "b", "c"], "a", "b")).toEqual(["b", "a", "c"]);
    expect(moveBookmarkId(["a", "b"], "a", "b")).toEqual(["b", "a"]);
    expect(moveBookmarkId(["a", "b"], "b", "a")).toEqual(["b", "a"]);
    expect(moveBookmarkId(["a", "b", "c"], "a", "a")).toEqual(["a", "b", "c"]);
  });
});

describe("profile order helpers", () => {
  it("reads and writes per-connection order", () => {
    expect(orderForProfile({ p1: ["a"] }, "p1")).toEqual(["a"]);
    expect(orderForProfile({ p1: ["a"] }, "p2")).toEqual([]);
    expect(orderForProfile(null, "p1")).toEqual([]);
    expect(withProfileOrder({ p1: ["a"] }, "p2", ["b"])).toEqual({ p1: ["a"], p2: ["b"] });
    expect(bookmarkIds([bookmark({ id: "x", label: "X", path: "/x" })])).toEqual(["x"]);
  });
});
