import { Bookmark, ChevronDown, ChevronRight, Folder, HardDrive, Star } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { Favorite } from "../types";

export function BookmarksSection({
  bookmarks,
  activeLocalPath,
  activeRemotePath,
  onOpen,
  onRemove,
}: {
  bookmarks: Favorite[];
  activeLocalPath?: string | null;
  activeRemotePath?: string | null;
  onOpen: (bookmark: Favorite) => void;
  onRemove: (bookmark: Favorite) => void;
}) {
  return (
    <CollapsibleSection title="Bookmarks" icon={<Bookmark size={14} />}>
      {bookmarks.length === 0 && (
        <p className="empty-note">Star a folder in the path bar</p>
      )}
      {bookmarks.map((bookmark) => {
        const active =
          bookmark.side === "remote"
            ? activeRemotePath === bookmark.path
            : activeLocalPath === bookmark.path;
        return (
          <div key={bookmark.id} className={`bookmark-item${active ? " active" : ""}`}>
            <button
              type="button"
              className="bookmark-open"
              title={bookmark.path}
              onClick={() => onOpen(bookmark)}
            >
              {bookmark.side === "remote" ? <HardDrive size={14} /> : <Folder size={14} />}
              <span className="bookmark-copy">
                <strong>{bookmark.label}</strong>
                <small>{bookmark.path}</small>
              </span>
            </button>
            <button
              type="button"
              className="favorite-toggle"
              aria-label={`Remove bookmark ${bookmark.label}`}
              title="Remove bookmark"
              onClick={() => onRemove(bookmark)}
            >
              <Star size={14} fill="currentColor" />
            </button>
          </div>
        );
      })}
    </CollapsibleSection>
  );
}

function CollapsibleSection({
  title,
  icon,
  children,
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <section className="sidebar-section">
      <button type="button" className="section-heading" onClick={() => setOpen(!open)}>
        {icon}
        <span>{title}</span>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button>
      {open && <div className="section-items">{children}</div>}
    </section>
  );
}
