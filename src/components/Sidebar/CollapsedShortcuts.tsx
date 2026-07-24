import { Folder, HardDrive, LoaderCircle, Star } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { planCollapsedBookmarks } from "../../lib/collapsedBookmarks";
import type { ConnectionProfile, Favorite, UUID } from "../../types";
import { CollapsedBookmarkButton } from "./CollapsedBookmarkButton";

export function CollapsedShortcuts({
  favoriteProfiles,
  bookmarks,
  activeProfileId,
  connectingId,
  activeLocalPath,
  activeRemotePath,
  onProfileClick,
  onOpenBookmark,
}: {
  favoriteProfiles: ConnectionProfile[];
  bookmarks: Favorite[];
  activeProfileId: UUID | null;
  connectingId: UUID | null;
  activeLocalPath: string | null;
  activeRemotePath: string | null;
  onProfileClick: (profile: ConnectionProfile) => void;
  onOpenBookmark: (bookmark: Favorite) => void;
}) {
  const { visible, overflow } = planCollapsedBookmarks(
    bookmarks,
    favoriteProfiles.length,
    activeProfileId,
    activeLocalPath,
    activeRemotePath,
  );
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!overflowOpen) return;
    function onPointerDown(event: PointerEvent) {
      if (!overflowRef.current?.contains(event.target as Node)) {
        setOverflowOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOverflowOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [overflowOpen]);

  useEffect(() => {
    setOverflowOpen(false);
  }, [bookmarks, favoriteProfiles.length, activeProfileId]);

  if (favoriteProfiles.length === 0 && bookmarks.length === 0) return null;

  return (
    <div className="collapsed-shortcuts">
      {favoriteProfiles.length > 0 && (
        <nav className="collapsed-rail" aria-label="Favorite connections">
          {favoriteProfiles.map((profile) => (
            <button
              key={profile.id}
              type="button"
              className={activeProfileId === profile.id ? "active" : ""}
              aria-label={`Open favorite ${profile.label}`}
              title={profile.label}
              onClick={() => onProfileClick(profile)}
            >
              {connectingId === profile.id ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                <>
                  <span>{profileInitials(profile.label)}</span>
                  <Star size={10} fill="currentColor" />
                </>
              )}
            </button>
          ))}
        </nav>
      )}

      {bookmarks.length > 0 && (
        <nav className="collapsed-rail collapsed-bookmarks" aria-label="Bookmarks">
          {visible.map((bookmark) => {
            const active =
              bookmark.side === "remote"
                ? activeRemotePath === bookmark.path
                : activeLocalPath === bookmark.path;
            return (
              <CollapsedBookmarkButton
                key={bookmark.id}
                bookmark={bookmark}
                active={active}
                onOpen={onOpenBookmark}
              />
            );
          })}

          {overflow.length > 0 && (
            <div className="collapsed-bookmark-overflow" ref={overflowRef}>
              <button
                type="button"
                className={overflowOpen ? "active" : ""}
                aria-label={`Show ${overflow.length} more bookmarks`}
                aria-expanded={overflowOpen}
                title={`${overflow.length} more bookmarks`}
                onClick={() => setOverflowOpen((open) => !open)}
              >
                +{overflow.length}
              </button>
              {overflowOpen && (
                <div className="collapsed-bookmark-menu" role="menu">
                  {overflow.map((bookmark) => {
                    const active =
                      bookmark.side === "remote"
                        ? activeRemotePath === bookmark.path
                        : activeLocalPath === bookmark.path;
                    return (
                      <button
                        key={bookmark.id}
                        type="button"
                        role="menuitem"
                        className={active ? "active" : ""}
                        title={bookmark.path}
                        onClick={() => {
                          setOverflowOpen(false);
                          onOpenBookmark(bookmark);
                        }}
                      >
                        {bookmark.side === "remote" ? (
                          <HardDrive size={14} />
                        ) : (
                          <Folder size={14} />
                        )}
                        <span>
                          <strong>{bookmark.label}</strong>
                          <small>{bookmark.path}</small>
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </nav>
      )}
    </div>
  );
}

function profileInitials(label: string) {
  return (
    label
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "S"
  );
}
