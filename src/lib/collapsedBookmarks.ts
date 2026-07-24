import type { Favorite } from "../types";

/** Max shortcut tiles (favorites + bookmarks) before the rail feels cramped. */
export const COLLAPSED_SHORTCUT_BUDGET = 6;
/** Cap on bookmark tiles even when favorites leave room. */
export const COLLAPSED_BOOKMARK_CAP = 3;

export function collapsedBookmarkBudget(
  favoriteCount: number,
  totalBudget = COLLAPSED_SHORTCUT_BUDGET,
  bookmarkCap = COLLAPSED_BOOKMARK_CAP,
) {
  return Math.max(0, Math.min(bookmarkCap, totalBudget - Math.max(0, favoriteCount)));
}

function bookmarkScore(
  bookmark: Favorite,
  activeProfileId: string | null,
  activeLocalPath: string | null,
  activeRemotePath: string | null,
) {
  let score = 0;
  const activePath = bookmark.side === "remote" ? activeRemotePath : activeLocalPath;
  if (activePath && activePath === bookmark.path) score += 100;
  if (activeProfileId && bookmark.profile_id === activeProfileId) score += 50;
  if (bookmark.profile_id == null) score += 30;
  if (bookmark.side === "local") score += 10;
  return score;
}

export function rankCollapsedBookmarks(
  bookmarks: Favorite[],
  activeProfileId: string | null,
  activeLocalPath: string | null,
  activeRemotePath: string | null,
) {
  return [...bookmarks].sort((left, right) => {
    const scoreDiff =
      bookmarkScore(right, activeProfileId, activeLocalPath, activeRemotePath) -
      bookmarkScore(left, activeProfileId, activeLocalPath, activeRemotePath);
    if (scoreDiff !== 0) return scoreDiff;
    return left.label.localeCompare(right.label) || left.path.localeCompare(right.path);
  });
}

export function planCollapsedBookmarks(
  bookmarks: Favorite[],
  favoriteCount: number,
  activeProfileId: string | null,
  activeLocalPath: string | null,
  activeRemotePath: string | null,
) {
  const ranked = rankCollapsedBookmarks(
    bookmarks,
    activeProfileId,
    activeLocalPath,
    activeRemotePath,
  );
  const budget = collapsedBookmarkBudget(favoriteCount);

  if (ranked.length === 0) {
    return { visible: [] as Favorite[], overflow: [] as Favorite[] };
  }

  // No tile budget left: keep one overflow control so bookmarks stay reachable.
  if (budget === 0) {
    return { visible: [] as Favorite[], overflow: ranked };
  }

  if (ranked.length <= budget) {
    return { visible: ranked, overflow: [] as Favorite[] };
  }

  // Reserve one slot for the "+N" overflow control.
  const visibleCount = Math.max(0, budget - 1);
  return {
    visible: ranked.slice(0, visibleCount),
    overflow: ranked.slice(visibleCount),
  };
}
