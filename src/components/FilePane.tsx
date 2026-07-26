import {
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  ArrowLeft,
  Bookmark,
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  Folder,
  FolderOpen,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { formatBytes } from "../lib/format";
import { sortEntries, type SortDir, type SortKey } from "../lib/fileSort";
import type { PaneSide } from "../lib/filePaneDnD";
import { parentPath } from "../lib/paths";
import { useFilePaneDnD, type PaneDropHandler } from "../hooks/useFilePaneDnD";
import type { ComparisonStatus, FileEntry } from "../types";
import { FilePaneContextMenu } from "./FilePaneContextMenu";
import { FilePaneRows } from "./FilePaneRows";

export type { PaneSide };

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
  onFocus,
  onSelectionChange,
  onNavigate,
  onBrowse,
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
  onRevealInFileManager,
  onTransfer,
  transferLabel,
  onPaneDrop,
  bookmarked = false,
  onToggleBookmark,
  comparisonByName,
  warning,
}: {
  title: string;
  subtitle?: string;
  side: PaneSide;
  path: string;
  entries: FileEntry[];
  selected: FileEntry[];
  loading: boolean;
  showHidden: boolean;
  onFocus?: () => void;
  onSelectionChange: (entries: FileEntry[]) => void;
  onNavigate: (path: string) => void;
  onBrowse?: () => void;
  onRefresh: () => void;
  onToggleHidden: () => void;
  onCreateFile: () => void;
  onCreateDirectory: () => void;
  onCreateFilePrivileged?: () => void;
  onCreateDirectoryPrivileged?: () => void;
  onRemove: (entry: FileEntry) => void;
  onRemovePrivileged?: (entry: FileEntry) => void;
  onOpenFile: (entry: FileEntry) => void;
  onOpenPrivileged?: (entry: FileEntry) => void;
  onShowInfo: (entry: FileEntry) => void;
  onRevealInFileManager?: (path: string) => void;
  onTransfer?: (entry: FileEntry) => void;
  transferLabel?: string;
  onPaneDrop?: PaneDropHandler;
  bookmarked?: boolean;
  onToggleBookmark?: () => void;
  comparisonByName?: Record<string, ComparisonStatus>;
  warning?: string | null;
}) {
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    entry: FileEntry | null;
  } | null>(null);
  const anchorPath = useRef<string | null>(null);

  const dnd = useFilePaneDnD(side, (entry) => onSelectionChange([entry]), onPaneDrop);

  const visible = useMemo(() => {
    const filtered = entries.filter(
      (entry) =>
        (showHidden || !entry.hidden) && entry.name.toLowerCase().includes(query.toLowerCase()),
    );
    return sortEntries(filtered, sortKey, sortDir);
  }, [entries, query, showHidden, sortKey, sortDir]);

  function openContextMenu(event: ReactMouseEvent, entry: FileEntry | null) {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ x: event.clientX, y: event.clientY, entry });
  }

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((dir) => (dir === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(key);
    setSortDir(key === "name" ? "asc" : "desc");
  }

  function selectEntry(entry: FileEntry, event: ReactMouseEvent) {
    const index = visible.findIndex((item) => item.path === entry.path);
    const anchorIndex = visible.findIndex((item) => item.path === anchorPath.current);
    if (event.shiftKey && anchorIndex >= 0) {
      const start = Math.min(anchorIndex, index);
      const end = Math.max(anchorIndex, index);
      onSelectionChange(visible.slice(start, end + 1));
    } else if (event.metaKey || event.ctrlKey) {
      onSelectionChange(
        selected.some((item) => item.path === entry.path)
          ? selected.filter((item) => item.path !== entry.path)
          : [...selected, entry],
      );
      anchorPath.current = entry.path;
    } else {
      onSelectionChange([entry]);
      anchorPath.current = entry.path;
    }
  }

  function handleKeys(event: KeyboardEvent<HTMLDivElement>) {
    const isMod = event.metaKey || event.ctrlKey;
    if (isMod && event.key.toLowerCase() === "a") {
      event.preventDefault();
      onSelectionChange(visible);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End", "Enter"].includes(event.key)) return;
    event.preventDefault();
    const current = selected.at(-1);
    if (event.key === "Enter" && current) {
      current.kind === "directory" ? onNavigate(current.path) : onOpenFile(current);
      return;
    }
    const currentIndex = visible.findIndex((entry) => entry.path === current?.path);
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? visible.length - 1
          : Math.max(
              0,
              Math.min(visible.length - 1, currentIndex + (event.key === "ArrowDown" ? 1 : -1)),
            );
    const next = visible[nextIndex];
    if (!next) return;
    if (event.shiftKey) {
      const paths = new Set(selected.map((entry) => entry.path));
      paths.add(next.path);
      onSelectionChange(visible.filter((entry) => paths.has(entry.path)));
    } else {
      onSelectionChange([next]);
      anchorPath.current = next.path;
    }
  }

  return (
    <section
      className={`file-pane${dnd.dragOverPane ? " is-drop-target" : ""}`}
      aria-label={`${title} files`}
      data-pane-side={side}
      data-pane-path={path}
      onFocusCapture={() => onFocus?.()}
      onMouseDown={() => onFocus?.()}
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
          <span title={path}>{path}</span>
          {onBrowse && (
            <button
              type="button"
              className="path-browse"
              title="Browse folder"
              aria-label="Browse folder"
              onClick={(event) => {
                event.stopPropagation();
                onBrowse();
              }}
            >
              <FolderOpen size={14} />
            </button>
          )}
          {onToggleBookmark && (
            <button
              type="button"
              className="path-bookmark"
              title={bookmarked ? "Remove bookmark" : "Bookmark this folder"}
              aria-label={bookmarked ? "Remove bookmark" : "Bookmark this folder"}
              aria-pressed={bookmarked}
              onClick={(event) => {
                event.stopPropagation();
                onToggleBookmark();
              }}
            >
              <Bookmark size={14} fill={bookmarked ? "currentColor" : "none"} />
            </button>
          )}
        </div>
        <label className={`filter-field${query ? " has-value" : ""}`}>
          <Search size={14} />
          <input
            aria-label={`Filter ${title} files`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter"
          />
          {query && (
            <button
              type="button"
              className="filter-clear"
              aria-label={`Clear ${title} filter`}
              title="Clear filter"
              onClick={(event) => {
                event.preventDefault();
                setQuery("");
              }}
            >
              <X size={12} />
            </button>
          )}
        </label>
      </div>
      <div className="file-table" role="table">
        {warning && <div className="pane-warning">{warning}</div>}
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
        <div className="file-rows" tabIndex={0} onKeyDown={handleKeys}>
          <FilePaneRows
            loading={loading}
            entriesEmpty={entries.length === 0}
            visible={visible}
            selectedPaths={new Set(selected.map((entry) => entry.path))}
            comparisonByName={comparisonByName}
            dragOverFolderPath={dnd.dragOverFolderPath}
            draggingPath={dnd.draggingPath}
            onSelect={selectEntry}
            onNavigate={onNavigate}
            onOpenFile={onOpenFile}
            onContextMenu={openContextMenu}
            onPointerDownRow={dnd.handleRowPointerDown}
          />
        </div>
      </div>
      <footer className="pane-footer">
        <span>{selected.length > 0 ? `${selected.length} selected` : `${visible.length} items`}</span>
        <span>
          {formatBytes(
            (selected.length > 0 ? selected : visible).reduce(
              (sum, item) => sum + (item.size ?? 0),
              0,
            ),
          )}
        </span>
      </footer>
      {contextMenu && (
        <FilePaneContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          path={path}
          entry={contextMenu.entry}
          onClose={() => setContextMenu(null)}
          onOpenFile={onOpenFile}
          onOpenPrivileged={onOpenPrivileged}
          onCreateFile={onCreateFile}
          onCreateFilePrivileged={onCreateFilePrivileged}
          onCreateDirectory={onCreateDirectory}
          onCreateDirectoryPrivileged={onCreateDirectoryPrivileged}
          onShowInfo={onShowInfo}
          onRemove={onRemove}
          onRemovePrivileged={onRemovePrivileged}
          onRevealInFileManager={onRevealInFileManager}
          onTransfer={onTransfer}
          transferLabel={transferLabel}
        />
      )}
    </section>
  );
}
