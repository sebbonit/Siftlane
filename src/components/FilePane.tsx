import { useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  File,
  FileCode2,
  FileEdit,
  FilePlus2,
  Folder,
  FolderPlus,
  Info,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { formatBytes, formatDate, formatPermissions } from "../lib/format";
import { sortEntries, type SortDir, type SortKey } from "../lib/fileSort";
import { parentPath } from "../lib/paths";
import type { FileEntry } from "../types";

export type PaneSide = "local" | "remote";

const SORT_COLUMNS: Array<{ key: SortKey; label: string; ariaLabel?: string }> = [
  { key: "name", label: "Name" },
  { key: "size", label: "Size" },
  { key: "modified", label: "Modified" },
  { key: "mode", label: "Mode", ariaLabel: "Permissions" },
];

export function FilePane({
  title,
  subtitle,
  side,
  path,
  entries,
  selected,
  loading,
  showHidden,
  onSelect,
  onNavigate,
  onRefresh,
  onToggleHidden,
  onCreateFile,
  onCreateDirectory,
  onCreateFilePrivileged,
  onCreateDirectoryPrivileged,
  onRemove,
  onRemovePrivileged,
  onOpenFile,
  onOpenPrivileged,
  onShowInfo,
}: {
  title: string;
  subtitle?: string;
  side: PaneSide;
  path: string;
  entries: FileEntry[];
  selected: FileEntry | null;
  loading: boolean;
  showHidden: boolean;
  onSelect: (entry: FileEntry) => void;
  onNavigate: (path: string) => void;
  onRefresh: () => void;
  onToggleHidden: () => void;
  onCreateFile: () => void;
  onCreateDirectory: () => void;
  onCreateFilePrivileged: () => void;
  onCreateDirectoryPrivileged: () => void;
  onRemove: (entry: FileEntry) => void;
  onRemovePrivileged: (entry: FileEntry) => void;
  onOpenFile: (entry: FileEntry) => void;
  onOpenPrivileged: (entry: FileEntry) => void;
  onShowInfo: (entry: FileEntry) => void;
}) {
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    entry: FileEntry | null;
  } | null>(null);

  const visible = useMemo(() => {
    const filtered = entries.filter(
      (entry) =>
        (showHidden || !entry.hidden) && entry.name.toLowerCase().includes(query.toLowerCase()),
    );
    return sortEntries(filtered, sortKey, sortDir);
  }, [entries, query, showHidden, sortKey, sortDir]);

  function openContextMenu(event: ReactMouseEvent, entry: FileEntry | null) {
    event.preventDefault();
    setContextMenu({ x: event.clientX, y: event.clientY, entry });
  }

  function closeContextMenu(action?: () => void) {
    setContextMenu(null);
    action?.();
  }

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((dir) => (dir === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(key);
    setSortDir(key === "name" ? "asc" : "desc");
  }

  return (
    <section
      className="file-pane"
      aria-label={`${title} files`}
      onClick={() => setContextMenu(null)}
      onContextMenu={(event) => openContextMenu(event, null)}
    >
      <div className="pane-title">
        <div>
          <strong>{title}</strong>
          {subtitle && <span>{subtitle}</span>}
        </div>
        <div className="pane-actions">
          <button
            title={showHidden ? "Hide hidden files" : "Show hidden files"}
            onClick={onToggleHidden}
          >
            {showHidden ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
          <button title="Refresh" onClick={onRefresh}>
            <RefreshCw className={loading ? "spin" : ""} size={15} />
          </button>
        </div>
      </div>
      <div className="path-toolbar">
        <button title="Parent folder" onClick={() => onNavigate(parentPath(path, side === "remote"))}>
          <ArrowLeft size={15} />
        </button>
        <div className="path-field">
          <Folder size={15} />
          <span>{path}</span>
        </div>
        <label className="filter-field">
          <Search size={14} />
          <input
            aria-label={`Filter ${title} files`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter"
          />
        </label>
      </div>
      <div className="file-table" role="table">
        <div className="file-header" role="row">
          {SORT_COLUMNS.map((column) => (
            <button
              key={column.key}
              type="button"
              className={sortKey === column.key ? "sorted" : ""}
              aria-label={column.ariaLabel ?? column.label}
              aria-sort={
                sortKey === column.key
                  ? sortDir === "asc"
                    ? "ascending"
                    : "descending"
                  : "none"
              }
              onClick={() => toggleSort(column.key)}
            >
              <span>{column.label}</span>
              {sortKey === column.key &&
                (sortDir === "asc" ? <ChevronUp size={11} /> : <ChevronDown size={11} />)}
            </button>
          ))}
        </div>
        <div className="file-rows">
          {loading && entries.length === 0 ? (
            <div className="pane-message">
              <LoaderCircle className="spin" size={20} /> Loading directory…
            </div>
          ) : (
            visible.map((entry) => (
              <button
                key={entry.path}
                className={`file-row ${selected?.path === entry.path ? "selected" : ""}`}
                onClick={() => onSelect(entry)}
                onDoubleClick={() =>
                  entry.kind === "directory" ? onNavigate(entry.path) : onOpenFile(entry)
                }
                onContextMenu={(event) => {
                  event.stopPropagation();
                  onSelect(entry);
                  openContextMenu(event, entry);
                }}
                role="row"
              >
                <span className="file-name">
                  {fileIcon(entry)}
                  <span>{entry.name}</span>
                  {entry.kind === "symlink" && <small>→ {entry.symlink_target}</small>}
                </span>
                <span className="file-size">
                  {entry.kind === "directory" && entry.size == null ? "—" : formatBytes(entry.size)}
                </span>
                <span className="file-modified">{formatDate(entry.modified_at)}</span>
                <span className="permissions">{formatPermissions(entry.permissions)}</span>
              </button>
            ))
          )}
          {!loading && visible.length === 0 && <div className="pane-message">No matching files</div>}
        </div>
      </div>
      <footer className="pane-footer">
        <span>{visible.length} items</span>
        <span>{formatBytes(visible.reduce((sum, item) => sum + (item.size ?? 0), 0))}</span>
      </footer>
      {contextMenu && (
        <div
          className="file-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          {contextMenu.entry?.kind === "file" && (
            <>
              <button onClick={() => closeContextMenu(() => onOpenFile(contextMenu.entry!))}>
                <FileEdit size={14} />
                Edit file
              </button>
              <button onClick={() => closeContextMenu(() => onOpenPrivileged(contextMenu.entry!))}>
                <LockKeyhole size={14} />
                Edit with sudo
              </button>
              <i />
            </>
          )}
          <button onClick={() => closeContextMenu(onCreateFile)}>
            <FilePlus2 size={14} />
            New file
          </button>
          <button onClick={() => closeContextMenu(onCreateFilePrivileged)}>
            <LockKeyhole size={14} />
            New file with sudo
          </button>
          <button onClick={() => closeContextMenu(onCreateDirectory)}>
            <FolderPlus size={14} />
            New folder
          </button>
          <button onClick={() => closeContextMenu(onCreateDirectoryPrivileged)}>
            <LockKeyhole size={14} />
            New folder with sudo
          </button>
          {contextMenu.entry && (
            <>
              <i />
              <button onClick={() => closeContextMenu(() => onShowInfo(contextMenu.entry!))}>
                <Info size={14} />
                Get Info
              </button>
              <i />
              <button onClick={() => closeContextMenu(() => onRemove(contextMenu.entry!))}>
                <Trash2 size={14} />
                Delete
              </button>
              <button
                className="danger"
                onClick={() => closeContextMenu(() => onRemovePrivileged(contextMenu.entry!))}
              >
                <LockKeyhole size={14} />
                Delete with sudo
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function fileIcon(entry: FileEntry) {
  if (entry.kind === "directory") return <Folder size={17} fill="currentColor" />;
  if (/\.(tsx?|jsx?|html|css|json|rs)$/i.test(entry.name)) return <FileCode2 size={16} />;
  return <File size={16} />;
}
