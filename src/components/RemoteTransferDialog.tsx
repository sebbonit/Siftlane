import { useMemo, useState, type FormEvent } from "react";
import { ArrowRight, CircleAlert, Network, X } from "lucide-react";
import { joinPath } from "../lib/paths";
import type { ConflictPolicy, FileEntry, SessionTab } from "../types";

interface RemoteTransferDialogProps {
  source: SessionTab;
  destinations: SessionTab[];
  entries: FileEntry[];
  onClose: () => void;
  onConfirm: (
    destination: SessionTab,
    destinationPaths: Array<{ sourcePath: string; destinationPath: string }>,
    conflictPolicy: ConflictPolicy,
  ) => Promise<void>;
}

export function RemoteTransferDialog({
  source,
  destinations,
  entries,
  onClose,
  onConfirm,
}: RemoteTransferDialogProps) {
  const [destinationId, setDestinationId] = useState(destinations[0]?.id ?? "");
  const destination = destinations.find((tab) => tab.id === destinationId) ?? null;
  const [destinationDirectory, setDestinationDirectory] = useState(
    destinations[0]?.remotePath ?? "/",
  );
  const [conflictPolicy, setConflictPolicy] = useState<ConflictPolicy>("ask");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const routes = useMemo(
    () =>
      entries.map((entry) => ({
        sourcePath: entry.path,
        destinationPath: joinPath(destinationDirectory, entry.name, true),
      })),
    [destinationDirectory, entries],
  );

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!destination || routes.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm(destination, routes, conflictPolicy);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setSubmitting(false);
    }
  }

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        className="dialog remote-transfer-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="remote-transfer-title"
      >
        <header>
          <div>
            <h2 id="remote-transfer-title">Copy between remote sessions</h2>
            <p>Stream {entries.length} file{entries.length === 1 ? "" : "s"} through this device</p>
          </div>
          <button aria-label="Close dialog" onClick={onClose}><X size={17} /></button>
        </header>
        <form onSubmit={submit}>
          <div className="remote-route">
            <div>
              <span>Source</span>
              <strong>{source.label}</strong>
              <small>{source.protocol.toUpperCase()} · {source.host}</small>
            </div>
            <ArrowRight size={20} />
            <div>
              <span>Destination</span>
              <select
                aria-label="Destination session"
                value={destinationId}
                onChange={(event) => {
                  setDestinationId(event.target.value);
                  const next = destinations.find((tab) => tab.id === event.target.value);
                  if (next) setDestinationDirectory(next.remotePath);
                }}
              >
                {destinations.map((tab) => (
                  <option key={tab.id} value={tab.id}>{tab.label} · {tab.host}</option>
                ))}
              </select>
            </div>
          </div>
          <label>
            Destination directory
            <input
              value={destinationDirectory}
              onChange={(event) => setDestinationDirectory(event.target.value)}
              required
            />
          </label>
          <label>
            If a file exists
            <select
              value={conflictPolicy}
              onChange={(event) => setConflictPolicy(event.target.value as ConflictPolicy)}
            >
              <option value="ask">Ask before replacing</option>
              <option value="rename">Keep both (rename copy)</option>
              <option value="overwrite">Overwrite atomically</option>
              <option value="skip">Skip</option>
            </select>
          </label>
          <div className="remote-transfer-files">
            {routes.map((route) => (
              <div key={route.sourcePath}>
                <code>{source.label}:{route.sourcePath}</code>
                <ArrowRight size={13} />
                <code>{destination?.label ?? "Destination"}:{route.destinationPath}</code>
              </div>
            ))}
          </div>
          <p className="remote-stream-note">
            <Network size={15} />
            Bounded-memory stream · 256 KB chunks · atomic destination rename · no local working copy
          </p>
          {error && <p className="dialog-error"><CircleAlert size={14} />{error}</p>}
          <div className="dialog-actions">
            <button type="button" className="secondary" onClick={onClose}>Cancel</button>
            <button className="primary" disabled={submitting || !destination}>
              {submitting ? "Queuing…" : "Start remote copy"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
