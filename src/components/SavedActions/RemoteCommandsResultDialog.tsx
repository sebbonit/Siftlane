import { CircleAlert, CircleCheck, X } from "lucide-react";
import type { RemoteCommandResult } from "../../types";

const DISPLAY_LIMIT = 4000;

function truncateDisplay(text: string): string {
  if (text.length <= DISPLAY_LIMIT) return text;
  return `${text.slice(0, DISPLAY_LIMIT)}\n… (truncated)`;
}

export function RemoteCommandsResultDialog({
  label,
  results,
  onClose,
}: {
  label: string;
  results: RemoteCommandResult[];
  onClose: () => void;
}) {
  const failed = results.some((result) => result.exit_status !== 0);
  const title = failed ? "Remote commands failed" : "Remote commands finished";

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        className="dialog remote-commands-result-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="remote-commands-result-title"
      >
        <header>
          <div>
            <h2 id="remote-commands-result-title">{title}</h2>
            <p>{label}</p>
          </div>
          <button type="button" aria-label="Close dialog" onClick={onClose}>
            <X size={17} />
          </button>
        </header>
        <div className="remote-commands-result-list">
          {results.map((result, index) => {
            const ok = result.exit_status === 0;
            const statusLabel =
              result.exit_status === null ? "no status" : `exit ${result.exit_status}`;
            return (
              <article
                key={`${index}-${result.command}`}
                className={`remote-command-result ${ok ? "ok" : "failed"}`}
              >
                <header>
                  {ok ? <CircleCheck size={14} /> : <CircleAlert size={14} />}
                  <code>{result.command}</code>
                  <span>{statusLabel}</span>
                </header>
                {result.stdout.trim() && (
                  <pre aria-label="stdout">{truncateDisplay(result.stdout)}</pre>
                )}
                {result.stderr.trim() && (
                  <pre className="stderr" aria-label="stderr">
                    {truncateDisplay(result.stderr)}
                  </pre>
                )}
                {!result.stdout.trim() && !result.stderr.trim() && (
                  <p className="remote-command-empty">No output</p>
                )}
              </article>
            );
          })}
        </div>
        <div className="dialog-actions">
          <button type="button" className="primary" onClick={onClose}>
            Close
          </button>
        </div>
      </section>
    </div>
  );
}
