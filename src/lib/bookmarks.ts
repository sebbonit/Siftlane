import type { Favorite, UUID } from "../types";

/** Bookmarks belonging to the active connection only (never shared across servers). */
export function bookmarksForConnection(
  bookmarks: Favorite[],
  profileId: UUID | null | undefined,
): Favorite[] {
  if (!profileId) return [];
  return bookmarks.filter((bookmark) => bookmark.profile_id === profileId);
}

export function findBookmarkForPath(
  bookmarks: Favorite[],
  side: Favorite["side"],
  path: string,
  profileId: UUID | null,
): Favorite | null {
  if (!profileId) return null;
  return (
    bookmarks.find(
      (favorite) =>
        favorite.side === side &&
        favorite.path === path &&
        favorite.profile_id === profileId,
    ) ?? null
  );
}
