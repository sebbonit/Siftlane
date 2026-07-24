import { describe, expect, it } from "vitest";
import type { Favorite } from "../types";
import { bookmarksForConnection, findBookmarkForPath } from "./bookmarks";

function bookmark(partial: Partial<Favorite> & Pick<Favorite, "id" | "label" | "path">): Favorite {
  return {
    profile_id: "p1",
    side: "remote",
    ...partial,
  };
}

describe("bookmarksForConnection", () => {
  const items = [
    bookmark({ id: "a", label: "A", path: "/a", profile_id: "p1" }),
    bookmark({ id: "b", label: "B", path: "/b", profile_id: "p2" }),
    bookmark({ id: "c", label: "C", path: "/c", profile_id: null }),
  ];

  it("returns only bookmarks for the active connection", () => {
    expect(bookmarksForConnection(items, "p1").map((item) => item.id)).toEqual(["a"]);
    expect(bookmarksForConnection(items, "p2").map((item) => item.id)).toEqual(["b"]);
  });

  it("returns none when no connection is active", () => {
    expect(bookmarksForConnection(items, null)).toEqual([]);
    expect(bookmarksForConnection(items, undefined)).toEqual([]);
  });
});

describe("findBookmarkForPath", () => {
  const items = [
    bookmark({ id: "remote", label: "html", path: "/var/www/html", profile_id: "p1" }),
    bookmark({
      id: "local",
      label: "Projects",
      path: "/Users/me",
      profile_id: "p1",
      side: "local",
    }),
    bookmark({ id: "other", label: "html", path: "/var/www/html", profile_id: "p2" }),
  ];

  it("matches path and side only within the same connection", () => {
    expect(findBookmarkForPath(items, "remote", "/var/www/html", "p1")?.id).toBe("remote");
    expect(findBookmarkForPath(items, "local", "/Users/me", "p1")?.id).toBe("local");
    expect(findBookmarkForPath(items, "remote", "/var/www/html", "p2")?.id).toBe("other");
    expect(findBookmarkForPath(items, "remote", "/var/www/html", "p3")).toBeNull();
    expect(findBookmarkForPath(items, "remote", "/var/www/html", null)).toBeNull();
  });
});
