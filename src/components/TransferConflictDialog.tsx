import { AlertTriangle, Copy, Replace, SkipForward } from "lucide-react";
import { useState } from "react";
import { formatBytes } from "../lib/format";
import type { ConflictPolicy, TransferJob } from "../types";

export function TransferConflictDialog({
  job,
  batchRemaining,
  onResolve,
}: {
  job: TransferJob;
  batchRemaining: number;
  onResolve: (
    policy: Exclude<ConflictPolicy, "ask">,
    applyToBatch: boolean,
  ) => Promise<void>;
}) {
  const [applyToBatch, setApplyToBatch] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = job.destination_path.split(/[\\/]/).pop() || job.destination_path;

  async function resolve(policy: Exclude<ConflictPolicy, "ask">) {
    setResolving(true);
    setError(null);
    try {
      await onResolve(policy, applyToBatch);
    } catch (reason) {
      const message =
        reason instanceof Error
          ? reason.message
          : reason && typeof reason === "object" && "message" in reason
            ? String(reason.message)
            : String(reason);
      setError(message);
      setResolving(false);
    }
  }

  return (
    <div className="dialog-backdrop transfer-conflict-backdrop" role="presentation">
      <section
        className="dialog transfer-conflict-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="transfer-conflict-title"
      >
        <header>
          <div>
            <h2 id="transfer-conflict-title">
              <AlertTriangle size={19} /> “{name}” already exists
            </h2>
            <p>Choose how Siftlane should handle this destination.</p>
          </div>
        </header>
        <div className="transfer-conflict-details">
          <dl>
            <dt>Source</dt>
            <dd title={job.source_path}>{job.source_path}</dd>
            <dt>Destination</dt>
            <dd title={job.destination_path}>{job.destination_path}</dd>
            <dt>Size</dt>
            <dd>{formatBytes(job.bytes_total)}</dd>
          </dl>
          {batchRemaining > 1 && (
            <label className="checkbox transfer-conflict-apply">
              <input
                type="checkbox"
                checked={applyToBatch}
                disabled={resolving}
                onChange={(event) => setApplyToBatch(event.target.checked)}
              />
              Apply this choice to the remaining {batchRemaining} files in this folder transfer
            </label>
          )}
          {error && <p className="dialog-error">{error}</p>}
        </div>
        <footer className="transfer-conflict-actions">
          <button type="button" disabled={resolving} onClick={() => void resolve("skip")}>
            <SkipForward size={15} />
            Skip
          </button>
          <button type="button" disabled={resolving} onClick={() => void resolve("rename")}>
            <Copy size={15} />
            Keep Both
          </button>
          <button
            type="button"
            className="primary"
            disabled={resolving}
            onClick={() => void resolve("overwrite")}
          >
            <Replace size={15} />
            Replace
          </button>
        </footer>
      </section>
    </div>
  );
}
