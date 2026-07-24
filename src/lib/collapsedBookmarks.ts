import type { Favorite } from "../types";
import { orderBookmarks } from "./bookmarkOrder";

/** Max shortcut tiles (favorites + bookmarks) before the rail feels cramped. */
export const COLLAPSED_SHORTCUT_BUDGET = 6;
/** Cap kept for tests / callers that still budget favorite rail space. */
export const COLLAPSED_BOOKMARK_CAP = 3;

export function collapsedBookmarkBudget(
  favoriteCount: number,
  totalBudget = COLLAPSED_SHORTCUT_BUDGET,
  bookmarkCap = COLLAPSED_BOOKMARK_CAP,
) {
  return Math.max(0, Math.min(bookmarkCap, totalBudget - Math.max(0, favoriteCount)));
}

/** Ordered bookmarks for the collapsed 2-column rail (all tiles; scroll if needed). */
export function planCollapsedBookmarks(bookmarks: Favorite[], orderedIds: string[] = []) {
  return orderBookmarks(bookmarks, orderedIds);
}
