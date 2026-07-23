import { useEffect, useRef } from "react";
import { LoaderCircle, X } from "lucide-react";

export function LoadingOverlay({
  label,
  detail,
  onCancel,
}: {
  label: string;
  detail?: string;
  onCancel?: () => void;
}) {
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  useEffect(() => {
    if (!onCancel) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancelRef.current?.();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel != null]);

  return (
    <div
      className="loading-toast"
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label={label}
    >
      <span className="loading-toast-spinner" aria-hidden="true">
        <LoaderCircle className="spin" size={18} strokeWidth={2.25} />
      </span>
      <div className="loading-toast-copy">
        <strong>{label}</strong>
        {detail ? <small>{detail}</small> : null}
      </div>
      {onCancel ? (
        <button
          type="button"
          className="loading-toast-cancel"
          aria-label="Cancel"
          onClick={onCancel}
        >
          <X size={15} />
          Cancel
        </button>
      ) : null}
    </div>
  );
}
