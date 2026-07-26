import { AlertTriangle, ArrowDownToLine, ArrowUpFromLine, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { SyncAction } from "../lib/directoryComparison";
import { formatBytes } from "../lib/format";
import type { SyncMode } from "../types";

export function SyncReviewDialog({
  mode,
  actions,
  onModeChange,
  onClose,
  onConfirm,
}: {
  mode: SyncMode;
  actions: SyncAction[];
  onModeChange: (mode: SyncMode) => void;
  onClose: () => void;
  onConfirm: (actions: SyncAction[]) => void;
}) {
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const keyFor = (action: SyncAction) => `${action.kind}:${action.entry.path}`;
  const actionSignature = actions.map(keyFor).join("\n");
  useEffect(() => {
    setSelectedKeys(new Set(actions.map(keyFor)));
  }, [actionSignature]);
  const selectedActions = actions.filter((action) => selectedKeys.has(keyFor(action)));
  const destructive = selectedActions.filter((action) => action.kind.startsWith("delete")).length;
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="sync-review" role="dialog" aria-modal="true" aria-label="Review synchronization">
        <header>
          <div>
            <strong>Review synchronization</strong>
            <small>No transfers or deletions happen until you confirm this checklist.</small>
          </div>
          <button aria-label="Close" onClick={onClose}><X size={16} /></button>
        </header>
        <label>
          Mode
          <select value={mode} onChange={(event) => onModeChange(event.target.value as SyncMode)}>
            <option value="two_way">Two-way (newest wins)</option>
            <option value="upload_mirror">Upload mirror (local is source)</option>
            <option value="download_mirror">Download mirror (remote is source)</option>
          </select>
        </label>
        {destructive > 0 && (
          <div className="sync-destructive-warning">
            <AlertTriangle size={15} />
            {destructive} deletion{destructive === 1 ? "" : "s"} will be performed.
          </div>
        )}
        <div className="sync-checklist">
          {actions.map((action) => (
            <label key={keyFor(action)}>
              <input
                type="checkbox"
                checked={selectedKeys.has(keyFor(action))}
                onChange={(event) => {
                  const key = keyFor(action);
                  setSelectedKeys((current) => {
                    const next = new Set(current);
                    event.target.checked ? next.add(key) : next.delete(key);
                    return next;
                  });
                }}
              />
              {action.kind === "upload" && <ArrowUpFromLine size={14} />}
              {action.kind === "download" && <ArrowDownToLine size={14} />}
              {action.kind.startsWith("delete") && <Trash2 size={14} />}
              <span>
                <strong>{action.kind.replaceAll("_", " ")}</strong>
                <small>
                  {action.entry.path} · {formatBytes(action.entry.size)} ·{" "}
                  {action.reason.replaceAll("_", " ")}
                </small>
              </span>
            </label>
          ))}
          {actions.length === 0 && <p>These directories are already synchronized.</p>}
        </div>
        <footer>
          <span>{selectedActions.length} selected action{selectedActions.length === 1 ? "" : "s"}</span>
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary-action"
            disabled={selectedActions.length === 0}
            onClick={() => onConfirm(selectedActions)}
          >
            Confirm and queue
          </button>
        </footer>
      </section>
    </div>
  );
}
