import { useState, type FormEvent } from "react";
import { CircleAlert, LoaderCircle, X } from "lucide-react";
import type { PaneSide } from "./FilePane";
import { PathSuggestInput } from "./PathSuggestInput";

export function GoToPathDialog({
  side,
  initialPath,
  onClose,
  onSubmit,
  onListDirectories,
}: {
  side: PaneSide;
  initialPath: string;
  onClose: () => void;
  onSubmit: (path: string) => Promise<void>;
  onListDirectories: (parentPath: string) => Promise<string[]>;
}) {
  const [path, setPath] = useState(initialPath);
  const [saving, setSaving] = useState(false);
  const [pathError, setPathError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const next = path.trim().replace(/[\\/]+$/, "") || (side === "remote" ? "/" : path.trim());
    if (!next && side !== "remote") return;
    setSaving(true);
    setPathError(null);
    try {
      await onSubmit(next || "/");
      onClose();
    } catch (reason) {
      setPathError(
        reason instanceof Error
          ? reason.message
          : String((reason as { message?: string }).message ?? reason),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section className="dialog goto-path-dialog" role="dialog" aria-modal="true" aria-labelledby="goto-path-title">
        <header>
          <div>
            <h2 id="goto-path-title">Go to folder</h2>
            <p>Open a path in the {side} pane</p>
          </div>
          <button type="button" aria-label="Close dialog" onClick={onClose}>
            <X size={17} />
          </button>
        </header>
        <form className="new-entry-form" onSubmit={(event) => void submit(event)}>
          <label>
            Path
            <PathSuggestInput
              value={path}
              remote={side === "remote"}
              placeholder={side === "remote" ? "/var/www/html" : "/Users"}
              disabled={saving}
              onChange={setPath}
              onListDirectories={onListDirectories}
            />
          </label>
          {pathError && (
            <p className="dialog-error">
              <CircleAlert size={14} />
              {pathError}
            </p>
          )}
          <div className="dialog-actions">
            <button type="button" className="secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={saving || !path.trim()}>
              {saving && <LoaderCircle className="spin" size={15} />}
              Open
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
