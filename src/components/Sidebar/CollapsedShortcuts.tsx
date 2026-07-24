import { LoaderCircle, Star } from "lucide-react";
import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { bookmarkIds, moveBookmarkId } from "../../lib/bookmarkOrder";
import { planCollapsedBookmarks } from "../../lib/collapsedBookmarks";
import type { ConnectionProfile, Favorite, UUID } from "../../types";
import { CollapsedBookmarkButton } from "./CollapsedBookmarkButton";

const DRAG_THRESHOLD_PX = 5;

export function CollapsedShortcuts({
  favoriteProfiles,
  bookmarks,
  orderedIds,
  activeProfileId,
  connectingId,
  activeLocalPath,
  activeRemotePath,
  onProfileClick,
  onOpenBookmark,
  onReorderBookmarks,
}: {
  favoriteProfiles: ConnectionProfile[];
  bookmarks: Favorite[];
  orderedIds: string[];
  activeProfileId: UUID | null;
  connectingId: UUID | null;
  activeLocalPath: string | null;
  activeRemotePath: string | null;
  onProfileClick: (profile: ConnectionProfile) => void;
  onOpenBookmark: (bookmark: Favorite) => void;
  onReorderBookmarks: (orderedIds: string[]) => void;
}) {
  const ordered = planCollapsedBookmarks(bookmarks, orderedIds);
  const orderedRef = useRef(ordered);
  orderedRef.current = ordered;
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const dragRef = useRef<{
    id: string;
    bookmark: Favorite;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);

  if (favoriteProfiles.length === 0 && ordered.length === 0) return null;

  function clearDrag() {
    dragRef.current = null;
    setDraggingId(null);
    setDropTargetId(null);
  }

  function bookmarkIdFromPoint(clientX: number, clientY: number): string | null {
    const hit = document.elementFromPoint(clientX, clientY);
    const button = hit instanceof Element ? hit.closest("[data-bookmark-id]") : null;
    return button instanceof HTMLElement ? button.dataset.bookmarkId ?? null : null;
  }

  function handleBookmarkPointerDown(
    bookmark: Favorite,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) {
    event.preventDefault();
    dragRef.current = {
      id: bookmark.id,
      bookmark,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    };

    function onPointerMove(moveEvent: PointerEvent) {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = moveEvent.clientX - drag.startX;
      const dy = moveEvent.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX) {
        drag.moved = true;
        setDraggingId(drag.id);
      }
      if (!drag.moved) return;
      const overId = bookmarkIdFromPoint(moveEvent.clientX, moveEvent.clientY);
      setDropTargetId(overId && overId !== drag.id ? overId : null);
    }

    function onPointerUp(upEvent: PointerEvent) {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);

      const drag = dragRef.current;
      if (!drag) return;

      if (!drag.moved) {
        clearDrag();
        onOpenBookmark(drag.bookmark);
        return;
      }

      const targetId = bookmarkIdFromPoint(upEvent.clientX, upEvent.clientY);
      if (targetId && targetId !== drag.id) {
        onReorderBookmarks(
          moveBookmarkId(bookmarkIds(orderedRef.current), drag.id, targetId),
        );
      }
      clearDrag();
    }

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
  }

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

      {ordered.length > 0 && (
        <nav className="collapsed-bookmarks" aria-label="Bookmarks">
          {ordered.map((bookmark) => {
            const active =
              bookmark.side === "remote"
                ? activeRemotePath === bookmark.path
                : activeLocalPath === bookmark.path;
            return (
              <CollapsedBookmarkButton
                key={bookmark.id}
                bookmark={bookmark}
                active={active}
                dragging={draggingId === bookmark.id}
                dropTarget={dropTargetId === bookmark.id && draggingId !== bookmark.id}
                onPointerDownReorder={handleBookmarkPointerDown}
              />
            );
          })}
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
