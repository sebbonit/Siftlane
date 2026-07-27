import { CircleHelp } from "lucide-react";
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";

export function InfoTooltip({
  label,
  children,
}: {
  label: string;
  children: string;
}) {
  const tipId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties>({ top: 0, left: 0 });

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const tipWidth = 240;
    const margin = 8;
    const left = Math.min(
      Math.max(margin, rect.left + rect.width / 2 - tipWidth / 2),
      window.innerWidth - tipWidth - margin,
    );
    const preferBelow = rect.bottom + 10;
    const top =
      preferBelow + 72 > window.innerHeight
        ? Math.max(margin, rect.top - 10)
        : preferBelow;
    setStyle({
      top,
      left,
      width: tipWidth,
      transform: preferBelow + 72 > window.innerHeight ? "translateY(-100%)" : undefined,
    });
  }, [open]);

  function show() {
    setOpen(true);
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="info-tooltip-trigger"
        aria-label={`About ${label}`}
        aria-describedby={open ? tipId : undefined}
        onMouseEnter={show}
        onMouseLeave={() => setOpen(false)}
        onFocus={show}
        onBlur={() => setOpen(false)}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        <CircleHelp size={12} strokeWidth={2.25} aria-hidden />
      </button>
      {open &&
        createPortal(
          <div id={tipId} className="info-tooltip" role="tooltip" style={style}>
            {children}
          </div>,
          document.body,
        )}
    </>
  );
}
