import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

const VIEWPORT_PAD = 8;

export function ContextMenu({
  x,
  y,
  children,
  onClose,
}: {
  x: number;
  y: number;
  children: ReactNode;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x, y });

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;

    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const maxX = window.innerWidth - width - VIEWPORT_PAD;
    const maxY = window.innerHeight - height - VIEWPORT_PAD;
    setPosition({
      x: Math.min(Math.max(VIEWPORT_PAD, x), Math.max(VIEWPORT_PAD, maxX)),
      y: Math.min(Math.max(VIEWPORT_PAD, y), Math.max(VIEWPORT_PAD, maxY)),
    });
  }, [x, y, children]);

  useLayoutEffect(() => {
    function onPointerDown(event: PointerEvent) {
      if (menuRef.current?.contains(event.target as Node)) return;
      onClose();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    function onScroll() {
      onClose();
    }
    // Defer so the opening contextmenu / click does not immediately dismiss.
    const timer = window.setTimeout(() => {
      document.addEventListener("pointerdown", onPointerDown, true);
    }, 0);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onClose);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onClose);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={menuRef}
      className="file-context-menu"
      style={{ left: position.x, top: position.y }}
      role="menu"
      onContextMenu={(event) => event.preventDefault()}
      onClick={(event) => event.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}
