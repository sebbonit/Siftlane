import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Plus, Trash2, Zap } from "lucide-react";
import type { SavedAction } from "../../types";
import { savedActionKindLabel } from "./kinds";

export function SessionActionsMenu({
  actions,
  disabled,
  onRun,
  onAdd,
  onDelete,
}: {
  actions: SavedAction[];
  disabled?: boolean;
  onRun: (action: SavedAction) => void;
  onAdd: () => void;
  onDelete: (action: SavedAction) => void;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: 0, right: 0 });

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    setPosition({
      top: rect.bottom + 4,
      right: window.innerWidth - rect.right,
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="session-actions">
      <button
        ref={buttonRef}
        type="button"
        className="session-actions-trigger"
        aria-label="Session actions"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        <Zap size={14} />
        <span>Actions</span>
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="session-actions-menu"
            role="menu"
            style={{ top: position.top, right: position.right }}
          >
            {actions.length === 0 && (
              <p className="session-actions-empty">No saved actions yet</p>
            )}
            {actions.map((action) => (
              <div key={action.id} className="session-actions-row" role="none">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpen(false);
                    onRun(action);
                  }}
                >
                  <span>{action.label}</span>
                  <small>{savedActionKindLabel(action.kind)}</small>
                </button>
                <button
                  type="button"
                  className="session-actions-delete"
                  aria-label={`Delete ${action.label}`}
                  title="Delete action"
                  onClick={() => {
                    onDelete(action);
                  }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
            <i />
            <button
              type="button"
              role="menuitem"
              className="session-actions-add"
              onClick={() => {
                setOpen(false);
                onAdd();
              }}
            >
              <Plus size={14} />
              Add new…
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}
