import { CircleAlert, ExternalLink, LoaderCircle, Upload, X } from "lucide-react";
import { buildLineDiff } from "../lib/lineDiff";
import type { ExternalEditChange } from "../types";

export function ExternalEditDialog({
  change,
  saving,
  onKeepEditing,
  onUpload,
}: {
  change: ExternalEditChange;
  saving: boolean;
  onKeepEditing: () => void;
  onUpload: () => void;
}) {
  const rows = buildLineDiff(change.original_content, change.modified_content);
  const additions = rows.filter((row) => row.kind === "added").length;
  const removals = rows.filter((row) => row.kind === "removed").length;

  return (
    <div className="external-edit-overlay" role="dialog" aria-modal="true" aria-label="Review external edit">
      <section className="external-edit-dialog">
        <header>
          <span className="external-edit-icon">
            <ExternalLink size={18} />
          </span>
          <div>
            <h2>Review external changes</h2>
            <p>
              <strong>{change.name}</strong>
              <span>{change.remote_path}</span>
            </p>
          </div>
          <button aria-label="Keep editing" title="Keep editing" onClick={onKeepEditing}>
            <X size={17} />
          </button>
        </header>
        <div className="external-edit-warning">
          <CircleAlert size={15} />
          The remote file is unchanged. Upload only after reviewing this saved version.
        </div>
        <div className="external-diff-summary">
          <span>External editor saved a new version</span>
          <small>
            <b className="diff-added">+{additions}</b>
            <b className="diff-removed">−{removals}</b>
          </small>
        </div>
        <div className="external-diff">
          <div className="external-diff-heading">
            <strong>Remote version</strong>
            <strong>Saved locally</strong>
          </div>
          <div className="external-diff-body">
            {rows.map((row, index) => (
              <div className={`external-diff-row ${row.kind}`} key={`${index}-${row.kind}`}>
                <code>
                  <i>{row.beforeLine ?? ""}</i>
                  <span>{row.before || " "}</span>
                </code>
                <code>
                  <i>{row.afterLine ?? ""}</i>
                  <span>{row.after || " "}</span>
                </code>
              </div>
            ))}
          </div>
        </div>
        <footer>
          <p>
            Upload uses a temporary remote file, verification, and atomic rename.
          </p>
          <div className="dialog-actions">
            <button className="secondary" onClick={onKeepEditing}>
              Keep editing
            </button>
            <button className="primary" disabled={saving} onClick={onUpload}>
              {saving ? <LoaderCircle className="spin" size={15} /> : <Upload size={15} />}
              Upload changes
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
