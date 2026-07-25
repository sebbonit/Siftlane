import { useState, type FormEvent } from "react";
import { CircleAlert, X } from "lucide-react";
import { PathSuggestInput } from "../PathSuggestInput";
import type { ArchiveFormat, SavedActionKind } from "../../types";
import {
  SAVED_ACTION_KINDS,
  actionNeedsArchiveFormat,
  actionNeedsCommands,
  actionNeedsLocal,
  actionNeedsRemote,
  actionOptionalRemote,
  archiveFormatsForKind,
  defaultArchiveFormat,
  parseCommandLines,
} from "./kinds";

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
    archiveFormat: ArchiveFormat | null;
    commands: string[];
  }) => Promise<void>;
  onListLocalDirectories: (parentPath: string) => Promise<string[]>;
  onListRemoteDirectories: (parentPath: string) => Promise<string[]>;
}) {
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<SavedActionKind>("open_both");
  const [localPath, setLocalPath] = useState(initialLocalPath);
  const [remotePath, setRemotePath] = useState(initialRemotePath);
  const [commandsText, setCommandsText] = useState("");
  const [archiveFormat, setArchiveFormat] = useState<ArchiveFormat>(
    defaultArchiveFormat("package_local"),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsLocal = actionNeedsLocal(kind);
  const needsRemote = actionNeedsRemote(kind);
  const optionalRemote = actionOptionalRemote(kind);
  const needsFormat = actionNeedsArchiveFormat(kind);
  const needsCommands = actionNeedsCommands(kind);
  const formatOptions = archiveFormatsForKind(kind);
  const selected = SAVED_ACTION_KINDS.find((item) => item.kind === kind);

  function changeKind(next: SavedActionKind) {
    setKind(next);
    if (actionNeedsArchiveFormat(next)) {
      setArchiveFormat(defaultArchiveFormat(next));
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmedLabel = label.trim();
    if (!trimmedLabel) {
      setError("Enter a name for this action");
      return;
    }
    const nextLocal = needsLocal ? localPath.trim() : null;
    const showRemote = needsRemote || optionalRemote;
    const trimmedRemote = remotePath.trim().replace(/\/+$/, "") || "/";
    const nextRemote = needsRemote
      ? trimmedRemote
      : optionalRemote && remotePath.trim()
        ? trimmedRemote
        : null;
    const nextCommands = needsCommands ? parseCommandLines(commandsText) : [];
    if (needsLocal && !nextLocal) {
      setError("A local directory is required");
      return;
    }
    if (needsRemote && !nextRemote) {
      setError("A remote directory is required");
      return;
    }
    if (needsCommands && nextCommands.length === 0) {
      setError("Enter at least one remote command");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSubmit({
        label: trimmedLabel,
        kind,
        localPath: nextLocal,
        remotePath: showRemote ? nextRemote : null,
        archiveFormat: needsFormat ? archiveFormat : null,
        commands: nextCommands,
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
              onChange={(event) => changeKind(event.target.value as SavedActionKind)}
            >
              {SAVED_ACTION_KINDS.map((item) => (
                <option key={item.kind} value={item.kind}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          {selected && <p className="saved-action-hint">{selected.description}</p>}
          {needsFormat && (
            <label>
              Archive format
              <select
                value={archiveFormat}
                disabled={saving}
                onChange={(event) => setArchiveFormat(event.target.value as ArchiveFormat)}
              >
                {formatOptions.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {needsCommands && (
            <label>
              Commands
              <textarea
                value={commandsText}
                disabled={saving}
                rows={6}
                placeholder={"git pull\nnpm ci\nnpm run build"}
                spellCheck={false}
                aria-describedby="saved-action-commands-hint"
                onChange={(event) => setCommandsText(event.target.value)}
              />
            </label>
          )}
          {needsCommands && (
            <p id="saved-action-commands-hint" className="saved-action-field-hint">
              One shell command per line
            </p>
          )}
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
          {(needsRemote || optionalRemote) && (
            <label>
              {optionalRemote ? "Working directory (optional)" : "Remote directory"}
              <PathSuggestInput
                value={remotePath}
                remote
                placeholder="/var/www/html"
                disabled={saving}
                required={!optionalRemote}
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
