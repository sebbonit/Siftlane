import { Folder, HardDrive } from "lucide-react";
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import type { Favorite } from "../../types";

export function CollapsedBookmarkButton({
  bookmark,
  active,
  dragging,
  dropTarget,
  onPointerDownReorder,
}: {
  bookmark: Favorite;
  active: boolean;
  dragging?: boolean;
  dropTarget?: boolean;
  onPointerDownReorder: (
    bookmark: Favorite,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => void;
}) {
  const tipId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const sideLabel = bookmark.side === "remote" ? "Remote" : "Local";

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    setPosition({
      top: rect.top + rect.height / 2,
      left: rect.right + 10,
    });
  }, [open]);

  function showTip() {
    if (dragging) return;
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) {
      setPosition({
        top: rect.top + rect.height / 2,
        left: rect.right + 10,
      });
    }
    setOpen(true);
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        data-bookmark-id={bookmark.id}
        className={`collapsed-bookmark${active ? " active" : ""}${dragging ? " is-dragging" : ""}${dropTarget ? " is-drop-target" : ""}`}
        aria-label={`Open bookmark ${bookmark.label}`}
        aria-describedby={open ? tipId : undefined}
        title={`${bookmark.label} — drag to reorder`}
        onMouseEnter={showTip}
        onMouseLeave={() => setOpen(false)}
        onFocus={showTip}
        onBlur={() => setOpen(false)}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          setOpen(false);
          onPointerDownReorder(bookmark, event);
        }}
      >
        {bookmark.side === "remote" ? (
          <HardDrive size={14} strokeWidth={2.25} aria-hidden />
        ) : (
          <Folder size={14} strokeWidth={2.25} aria-hidden />
        )}
      </button>
      {open &&
        !dragging &&
        createPortal(
          <div
            id={tipId}
            className="collapsed-bookmark-tip"
            role="tooltip"
            style={{ top: position.top, left: position.left }}
          >
            <span className={`collapsed-bookmark-tip-side ${bookmark.side}`}>{sideLabel}</span>
            <strong>{bookmark.label}</strong>
            <small>{bookmark.path}</small>
          </div>,
          document.body,
        )}
    </>
  );
}
