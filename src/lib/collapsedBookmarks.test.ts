import { describe, expect, it } from "vitest";
import type { Favorite } from "../types";
import { collapsedBookmarkBudget, planCollapsedBookmarks } from "./collapsedBookmarks";

function bookmark(partial: Partial<Favorite> & Pick<Favorite, "id" | "label" | "path">): Favorite {
  return {
    profile_id: "p1",
    side: "local",
    ...partial,
  };
}

describe("collapsedBookmarkBudget", () => {
  it("leaves room for up to three bookmarks", () => {
    expect(collapsedBookmarkBudget(0)).toBe(3);
    expect(collapsedBookmarkBudget(2)).toBe(3);
    expect(collapsedBookmarkBudget(4)).toBe(2);
    expect(collapsedBookmarkBudget(6)).toBe(0);
    expect(collapsedBookmarkBudget(8)).toBe(0);
  });
});

describe("planCollapsedBookmarks", () => {
  const many = [
    bookmark({ id: "1", label: "One", path: "/1", profile_id: "p1" }),
    bookmark({ id: "2", label: "Two", path: "/2", profile_id: "p1" }),
    bookmark({ id: "3", label: "Three", path: "/3", profile_id: "p1" }),
    bookmark({ id: "4", label: "Four", path: "/4", profile_id: "p1" }),
  ];

  it("returns all bookmarks in saved order", () => {
    const planned = planCollapsedBookmarks(many, ["4", "2", "1", "3"]);
    expect(planned.map((item) => item.id)).toEqual(["4", "2", "1", "3"]);
  });

  it("appends unordered bookmarks by label", () => {
    const planned = planCollapsedBookmarks(many, ["3"]);
    expect(planned.map((item) => item.id)).toEqual(["3", "4", "1", "2"]);
  });
});
