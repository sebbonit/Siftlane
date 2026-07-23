import { CircleAlert, Download, LoaderCircle, X } from "lucide-react";
import type { AppUpdaterState } from "./useAppUpdater";

export function UpdateDialog({ updater }: { updater: AppUpdaterState }) {
  const { phase, update, progress, error, installUpdate, dismiss } = updater;
  const showAvailable =
    !!update && (phase === "available" || phase === "downloading" || phase === "restarting" || phase === "error");
  const showStatus = phase === "up_to_date" || (phase === "error" && !update);

  if (!showAvailable && !showStatus) return null;

  if (showStatus) {
    return (
      <div
        className="dialog-backdrop"
        role="presentation"
        onMouseDown={(event) => event.target === event.currentTarget && dismiss()}
      >
        <section className="dialog update-dialog" role="dialog" aria-modal="true" aria-labelledby="update-title">
          <header>
            <div>
              <h2 id="update-title">{phase === "error" ? "Update check failed" : "Up to date"}</h2>
              <p>Siftlane release updates</p>
            </div>
            <button type="button" aria-label="Close dialog" onClick={dismiss}>
              <X size={17} />
            </button>
          </header>
          <div className="update-dialog-body">
            {phase === "error" ? (
              <p className="dialog-error">
                <CircleAlert size={14} />
                {error}
              </p>
            ) : (
              <p>You're on the latest version.</p>
            )}
          </div>
          <div className="dialog-actions">
            <button type="button" className="primary" onClick={dismiss}>
              OK
            </button>
          </div>
        </section>
      </div>
    );
  }

  if (!update) return null;

  const busy = phase === "downloading" || phase === "restarting";

  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="dialog update-dialog" role="dialog" aria-modal="true" aria-labelledby="update-title">
        <header>
          <div>
            <h2 id="update-title">Update available</h2>
            <p>Version {update.version} is ready to install</p>
          </div>
          {!busy && (
            <button type="button" aria-label="Close dialog" onClick={dismiss}>
              <X size={17} />
            </button>
          )}
        </header>
        <div className="update-dialog-body">
          <p>
            A new Siftlane release is available
            {update.date ? ` (published ${new Date(update.date).toLocaleDateString()})` : ""}. Download and install it
            to stay current.
          </p>
          {update.body ? <pre className="update-notes">{update.body.trim()}</pre> : null}
          {busy && (
            <div className="update-progress" role="status" aria-live="polite">
              <div className="update-progress-bar">
                <span style={{ width: `${progress ?? 15}%` }} />
              </div>
              <p>
                {phase === "restarting"
                  ? "Restarting…"
                  : progress == null
                    ? "Downloading update…"
                    : `Downloading… ${progress}%`}
              </p>
            </div>
          )}
          {phase === "error" && error && (
            <p className="dialog-error">
              <CircleAlert size={14} />
              {error}
            </p>
          )}
        </div>
        <div className="dialog-actions">
          <button type="button" className="secondary" disabled={busy} onClick={dismiss}>
            Later
          </button>
          <button type="button" className="primary" disabled={busy} onClick={() => void installUpdate()}>
            {busy ? <LoaderCircle className="spin" size={15} /> : <Download size={15} />}
            {phase === "restarting" ? "Restarting…" : phase === "downloading" ? "Installing…" : "Install update"}
          </button>
        </div>
      </section>
    </div>
  );
}
