import { useEffect, useEffectEvent, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { CircleAlert, LoaderCircle, Search, X } from "lucide-react";
import { api } from "../lib/ipc";
import type { SearchMatch, UUID } from "../types";
import type { PaneSide } from "./FilePane";
import { SearchResultList } from "./SearchResultList";

export function SearchDialog({
  initialSide,
  localRoot,
  remoteRoot,
  sessionId,
  remoteAvailable,
  onClose,
  onOpenMatch,
}: {
  initialSide: PaneSide;
  localRoot: string;
  remoteRoot: string;
  sessionId: UUID | null;
  remoteAvailable: boolean;
  onClose: () => void;
  onOpenMatch: (side: PaneSide, match: SearchMatch) => void;
}) {
  const [side, setSide] = useState<PaneSide>(
    initialSide === "remote" && remoteAvailable ? "remote" : "local",
  );
  const [draft, setDraft] = useState("");
  const [activeQuery, setActiveQuery] = useState("");
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [running, setRunning] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [visited, setVisited] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const searchIdRef = useRef<UUID | null>(null);
  const root = side === "local" ? localRoot : remoteRoot;

  const handleProgress = useEffectEvent((progress: {
    search_id: UUID;
    matches: SearchMatch[];
    visited: number;
    truncated: boolean;
    done: boolean;
    cancelled: boolean;
    error?: string | null;
  }) => {
    if (progress.search_id !== searchIdRef.current) return;
    if (progress.matches.length > 0) {
      setMatches((current) => [...current, ...progress.matches]);
    }
    setVisited(progress.visited);
    setTruncated(progress.truncated);
    if (progress.error) setError(progress.error);
    if (progress.done) {
      setRunning(false);
      searchIdRef.current = null;
    }
  });

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void api.onSearchProgress((progress) => {
      if (active) handleProgress(progress);
    }).then((stop) => {
      unlisten = stop;
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  // Local search stays live-as-you-type; remote waits for Enter to avoid restarting network walks.
  useEffect(() => {
    if (side !== "local") return;
    const timer = window.setTimeout(() => setActiveQuery(draft.trim()), 200);
    return () => window.clearTimeout(timer);
  }, [draft, side]);

  useEffect(() => {
    setDraft("");
    setActiveQuery("");
    setMatches([]);
    setTruncated(false);
    setVisited(0);
    setError(null);
    setRunning(false);
    const current = searchIdRef.current;
    if (current) {
      searchIdRef.current = null;
      void api.cancelSearch(current);
    }
  }, [side, root]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      const current = searchIdRef.current;
      if (current) {
        searchIdRef.current = null;
        try {
          await api.cancelSearch(current);
        } catch {
          // Best-effort cancel of the previous walk.
        }
      }
      if (cancelled) return;

      setMatches([]);
      setTruncated(false);
      setVisited(0);
      setError(null);

      if (!activeQuery) {
        setRunning(false);
        return;
      }
      if (side === "remote" && (!remoteAvailable || !sessionId)) {
        setError("Connect a remote session to search the server");
        setRunning(false);
        return;
      }

      setRunning(true);
      try {
        const searchId =
          side === "local"
            ? await api.startSearchLocal(root, activeQuery)
            : await api.startSearchRemote(sessionId!, root, activeQuery);
        if (cancelled) {
          await api.cancelSearch(searchId);
          return;
        }
        searchIdRef.current = searchId;
      } catch (reason) {
        if (cancelled) return;
        setRunning(false);
        setError(
          reason instanceof Error
            ? reason.message
            : String((reason as { message?: string }).message ?? reason),
        );
      }
    }

    void run();
    return () => {
      cancelled = true;
      const current = searchIdRef.current;
      if (current) {
        searchIdRef.current = null;
        void api.cancelSearch(current);
      }
    };
  }, [activeQuery, side, root, remoteAvailable, sessionId]);

  function submitRemote(event?: FormEvent | KeyboardEvent) {
    event?.preventDefault();
    if (side !== "remote") return;
    setActiveQuery(draft.trim());
  }

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        className="dialog search-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="search-dialog-title"
      >
        <header>
          <div>
            <h2 id="search-dialog-title">Search files &amp; folders</h2>
            <p>
              {side === "remote"
                ? "Match file and folder names under the current remote path"
                : "Match file and folder names under the current local path"}
            </p>
          </div>
          <button type="button" aria-label="Close dialog" onClick={onClose}>
            <X size={17} />
          </button>
        </header>

        <div className="search-dialog-body">
          <div className="segmented two-options" role="tablist" aria-label="Search side">
            <button
              type="button"
              className={side === "local" ? "active" : ""}
              onClick={() => setSide("local")}
            >
              Local
            </button>
            <button
              type="button"
              className={side === "remote" ? "active" : ""}
              disabled={!remoteAvailable}
              onClick={() => remoteAvailable && setSide("remote")}
            >
              Remote
            </button>
          </div>

          <label className="search-query-field">
            <Search size={14} />
            <input
              autoFocus
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") submitRemote(event);
              }}
              placeholder={
                side === "remote" ? "File or folder name — press Enter" : "File or folder name"
              }
              aria-label="Search query"
            />
            {running && <LoaderCircle className="spin" size={14} />}
          </label>

          <p className="search-root-path" title={root}>
            Searching in {root}
            {side === "remote" ? " · skips node_modules, .git, vendor, …" : ""}
          </p>

          {error && (
            <p className="dialog-error">
              <CircleAlert size={14} />
              {error}
            </p>
          )}

          <SearchResultList
            matches={matches}
            query={activeQuery}
            draft={draft}
            side={side}
            running={running}
            onOpen={(match) => onOpenMatch(side, match)}
          />

          <footer className="search-dialog-footer">
            <span>
              {matches.length} match{matches.length === 1 ? "" : "es"}
              {visited > 0 ? ` · ${visited} folders` : ""}
              {truncated ? " · truncated" : ""}
            </span>
            <div className="search-dialog-footer-actions">
              {side === "remote" && !running && (
                <button
                  type="button"
                  className="primary"
                  disabled={!draft.trim()}
                  onClick={() => submitRemote()}
                >
                  Search
                </button>
              )}
              {running ? (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    const current = searchIdRef.current;
                    if (current) void api.cancelSearch(current);
                  }}
                >
                  Cancel
                </button>
              ) : (
                <button type="button" className="secondary" onClick={onClose}>
                  Close
                </button>
              )}
            </div>
          </footer>
        </div>
      </section>
    </div>
  );
}
