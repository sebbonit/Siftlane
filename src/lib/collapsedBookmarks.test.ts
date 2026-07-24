import { describe, expect, it } from "vitest";
import type { Favorite } from "../types";
import {
  collapsedBookmarkBudget,
  planCollapsedBookmarks,
  rankCollapsedBookmarks,
} from "./collapsedBookmarks";

function bookmark(partial: Partial<Favorite> & Pick<Favorite, "id" | "label" | "path">): Favorite {
  return {
    profile_id: null,
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

describe("rankCollapsedBookmarks", () => {
  it("prefers the active path, then the active profile", () => {
    const ranked = rankCollapsedBookmarks(
      [
        bookmark({ id: "a", label: "Other", path: "/other", profile_id: "p2", side: "remote" }),
        bookmark({ id: "b", label: "Profile", path: "/home", profile_id: "p1", side: "remote" }),
        bookmark({ id: "c", label: "Active", path: "/var/www", profile_id: "p2", side: "remote" }),
        bookmark({ id: "d", label: "Local", path: "/Users/me" }),
      ],
      "p1",
      null,
      "/var/www",
    );
    expect(ranked.map((item) => item.id)).toEqual(["c", "b", "d", "a"]);
  });
});

describe("planCollapsedBookmarks", () => {
  const many = [
    bookmark({ id: "1", label: "One", path: "/1" }),
    bookmark({ id: "2", label: "Two", path: "/2" }),
    bookmark({ id: "3", label: "Three", path: "/3" }),
    bookmark({ id: "4", label: "Four", path: "/4" }),
  ];

  it("shows all bookmarks when they fit", () => {
    const plan = planCollapsedBookmarks(many.slice(0, 2), 1, null, null, null);
    expect(plan.visible).toHaveLength(2);
    expect(plan.overflow).toHaveLength(0);
  });

  it("reserves a slot for overflow when over budget", () => {
    const plan = planCollapsedBookmarks(many, 2, null, null, null);
    expect(plan.visible).toHaveLength(2);
    expect(plan.overflow).toHaveLength(2);
  });

  it("keeps only an overflow menu when favorites fill the rail", () => {
    const plan = planCollapsedBookmarks(many, 6, null, null, null);
    expect(plan.visible).toHaveLength(0);
    expect(plan.overflow).toHaveLength(4);
  });
});
