import { useState, type FormEvent } from "react";
import { CircleAlert, X } from "lucide-react";
import { PathSuggestInput } from "../PathSuggestInput";
import type { SavedActionKind } from "../../types";
import { SAVED_ACTION_KINDS, actionNeedsLocal, actionNeedsRemote } from "./kinds";

export function SavedActionDialog({
  initialLocalPath,
  initialRemotePath,
  onClose,
  onSubmit,
  onListLocalDirectories,
  onListRemoteDirectories,
}: {
  initialLocalPath: string;
  initialRemotePath: string;
  onClose: () => void;
  onSubmit: (draft: {
    label: string;
    kind: SavedActionKind;
    localPath: string | null;
    remotePath: string | null;
  }) => Promise<void>;
  onListLocalDirectories: (parentPath: string) => Promise<string[]>;
  onListRemoteDirectories: (parentPath: string) => Promise<string[]>;
}) {
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<SavedActionKind>("open_both");
  const [localPath, setLocalPath] = useState(initialLocalPath);
  const [remotePath, setRemotePath] = useState(initialRemotePath);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsLocal = actionNeedsLocal(kind);
  const needsRemote = actionNeedsRemote(kind);
  const selected = SAVED_ACTION_KINDS.find((item) => item.kind === kind);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmedLabel = label.trim();
    if (!trimmedLabel) {
      setError("Enter a name for this action");
      return;
    }
    const nextLocal = needsLocal ? localPath.trim() : null;
    const nextRemote = needsRemote ? remotePath.trim().replace(/\/+$/, "") || "/" : null;
    if (needsLocal && !nextLocal) {
      setError("A local directory is required");
      return;
    }
    if (needsRemote && !nextRemote) {
      setError("A remote directory is required");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSubmit({
        label: trimmedLabel,
        kind,
        localPath: nextLocal,
        remotePath: nextRemote,
      });
      onClose();
    } catch (reason) {
      setError(
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
      <section
        className="dialog saved-action-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="saved-action-title"
      >
        <header>
          <div>
            <h2 id="saved-action-title">Add action</h2>
            <p>Save a frequent workflow to run from the session tabs</p>
          </div>
          <button type="button" aria-label="Close dialog" onClick={onClose}>
            <X size={17} />
          </button>
        </header>
        <form className="new-entry-form" onSubmit={(event) => void submit(event)}>
          <label>
            Name
            <input
              autoFocus
              value={label}
              disabled={saving}
              placeholder="Deploy site files"
              onChange={(event) => setLabel(event.target.value)}
              required
            />
          </label>
          <label>
            Action type
            <select
              value={kind}
              disabled={saving}
              onChange={(event) => setKind(event.target.value as SavedActionKind)}
            >
              {SAVED_ACTION_KINDS.map((item) => (
                <option key={item.kind} value={item.kind}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          {selected && <p className="saved-action-hint">{selected.description}</p>}
          {needsLocal && (
            <label>
              Local directory
              <PathSuggestInput
                value={localPath}
                remote={false}
                placeholder="/Users/you/project"
                disabled={saving}
                onChange={setLocalPath}
                onListDirectories={onListLocalDirectories}
              />
            </label>
          )}
          {needsRemote && (
            <label>
              Remote directory
              <PathSuggestInput
                value={remotePath}
                remote
                placeholder="/var/www/html"
                disabled={saving}
                onChange={setRemotePath}
                onListDirectories={onListRemoteDirectories}
              />
            </label>
          )}
          {error && (
            <p className="dialog-error">
              <CircleAlert size={14} />
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <button type="button" className="secondary" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={saving}>
              {saving ? "Saving…" : "Save action"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
