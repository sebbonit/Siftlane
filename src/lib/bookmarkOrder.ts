import type { Favorite } from "../types";

/** Sort bookmarks by a saved id list; unknown ids append in label order. */
export function orderBookmarks(bookmarks: Favorite[], orderedIds: string[]): Favorite[] {
  if (bookmarks.length <= 1) return [...bookmarks];
  const byId = new Map(bookmarks.map((bookmark) => [bookmark.id, bookmark]));
  const seen = new Set<string>();
  const ordered: Favorite[] = [];

  for (const id of orderedIds) {
    const bookmark = byId.get(id);
    if (!bookmark || seen.has(id)) continue;
    ordered.push(bookmark);
    seen.add(id);
  }

  const rest = bookmarks
    .filter((bookmark) => !seen.has(bookmark.id))
    .sort(
      (left, right) =>
        left.label.localeCompare(right.label) || left.path.localeCompare(right.path),
    );
  return [...ordered, ...rest];
}

/** Move `fromId` onto `toId`'s slot (before when moving up, after when moving down). */
export function moveBookmarkId(ids: string[], fromId: string, toId: string): string[] {
  if (fromId === toId) return ids;
  const fromIndex = ids.indexOf(fromId);
  const toIndex = ids.indexOf(toId);
  if (fromIndex < 0 || toIndex < 0) return ids;
  const next = [...ids];
  next.splice(fromIndex, 1);
  const targetIndex = next.indexOf(toId);
  if (targetIndex < 0) return ids;
  const insertAt = fromIndex < toIndex ? targetIndex + 1 : targetIndex;
  next.splice(insertAt, 0, fromId);
  return next;
}

export function bookmarkIds(bookmarks: Favorite[]): string[] {
  return bookmarks.map((bookmark) => bookmark.id);
}

export function orderForProfile(
  orderByProfile: Record<string, string[]> | null | undefined,
  profileId: string | null | undefined,
): string[] {
  if (!profileId || !orderByProfile) return [];
  return orderByProfile[profileId] ?? [];
}

export function withProfileOrder(
  orderByProfile: Record<string, string[]> | null | undefined,
  profileId: string,
  orderedIds: string[],
): Record<string, string[]> {
  return {
    ...(orderByProfile ?? {}),
    [profileId]: orderedIds,
  };
}
