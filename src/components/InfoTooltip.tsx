import { CircleHelp } from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";

const CLOSE_DELAY_MS = 150;

export function InfoTooltip({
  label,
  children,
}: {
  label: string;
  children: string;
}) {
  const tipId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties>({ top: 0, left: 0 });

  function clearCloseTimer() {
    if (closeTimerRef.current != null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }

  function show() {
    clearCloseTimer();
    setOpen(true);
  }

  function hideSoon() {
    clearCloseTimer();
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setOpen(false);
    }, CLOSE_DELAY_MS);
  }

  useEffect(() => () => clearCloseTimer(), []);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const tipWidth = 240;
    const margin = 8;
    const gap = 8;
    const left = Math.min(
      Math.max(margin, rect.left + rect.width / 2 - tipWidth / 2),
      window.innerWidth - tipWidth - margin,
    );
    const tipHeight = tipRef.current?.offsetHeight ?? 72;
    const spaceBelow = window.innerHeight - rect.bottom - margin;
    const placeBelow = spaceBelow >= tipHeight + gap || spaceBelow >= rect.top;
    setStyle({
      top: placeBelow ? rect.bottom + gap : Math.max(margin, rect.top - gap),
      left,
      width: tipWidth,
      transform: placeBelow ? undefined : "translateY(-100%)",
    });
  }, [open, children]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="info-tooltip-trigger"
        aria-label={`About ${label}`}
        aria-describedby={open ? tipId : undefined}
        onMouseEnter={show}
        onMouseLeave={hideSoon}
        onFocus={show}
        onBlur={hideSoon}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          clearCloseTimer();
          setOpen((value) => !value);
        }}
      >
        <CircleHelp size={12} strokeWidth={2.25} aria-hidden />
      </button>
      {open &&
        createPortal(
          <div
            ref={tipRef}
            id={tipId}
            className="info-tooltip"
            role="tooltip"
            style={style}
            onMouseEnter={show}
            onMouseLeave={hideSoon}
          >
            {children}
          </div>,
          document.body,
        )}
    </>
  );
}
