import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ArrowLeft,
  ArrowRight,
  ArrowRightLeft,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock3,
  Eye,
  EyeOff,
  ExternalLink,
  FileKey2,
  Folder,
  FolderClock,
  FolderHeart,
  KeyRound,
  LayoutPanelLeft,
  ListFilter,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  Search,
  Server,
  Settings,
  ShieldAlert,
  Star,
  X,
} from "lucide-react";
import { BookmarksSection } from "./components/BookmarksSection";
import { FileInfoDialog } from "./components/FileInfoDialog";
import { ExternalEditDialog } from "./components/ExternalEditDialog";
import { FilePane, type PaneSide } from "./components/FilePane";
import { FilePaneDragGhost } from "./components/FilePaneDragGhost";
import { GoToPathDialog } from "./components/GoToPathDialog";
import { InfoTooltip } from "./components/InfoTooltip";
import { CollapsedShortcuts } from "./components/Sidebar/CollapsedShortcuts";
import { ImagePreview } from "./components/ImagePreview";
import { LoadingOverlay } from "./components/LoadingOverlay";
import {
  RemoteCommandsResultDialog,
  SavedActionDialog,
  SessionActionsMenu,
  newSavedActionId,
  runSavedAction,
} from "./components/SavedActions";
import { SearchDialog } from "./components/SearchDialog";
import { SettingsView } from "./components/Settings";
import { TransferPanel } from "./components/TransferPanel";
import { RemoteTransferDialog } from "./components/RemoteTransferDialog";
import { SyncReviewDialog } from "./components/SyncReviewDialog";
import { AppUpdater } from "./components/Updater";
import { api, desktop } from "./lib/ipc";
import { DEFAULT_SSH_OPTIONS } from "./types";
import { isImageFile } from "./lib/media";
import {
  compareDirectories,
  planSynchronization,
  type SyncAction,
} from "./lib/directoryComparison";
import { bookmarksForConnection, findBookmarkForPath } from "./lib/bookmarks";
import {
  bookmarkIds,
  orderBookmarks,
  orderForProfile,
  withProfileOrder,
} from "./lib/bookmarkOrder";
import { joinPath, normalizeBookmarkPath, pathBasename } from "./lib/paths";
import { useAppStore } from "./store";
import type {
  AppError,
  AuthRef,
  ConnectionProfile,
  ConflictPolicy,
  Favorite,
  FileEntry,
  HostKeyChallenge,
  Preferences,
  PreviewFile,
  RemoteCommandResult,
  SavedAction,
  SessionTab,
  UUID,
  EditableFile,
  ExternalEditChange,
  ExternalEditStarted,
  SearchMatch,
  SymlinkPolicy,
  SyncMode,
  TransferJob,
} from "./types";
import appIcon from "../src-tauri/icons/128x128.png";

type EntryCreation = { side: PaneSide; directory: boolean; privileged: boolean };
type SudoPrompt = { path: string; resolve: (password: string | null) => void };
type InfoTarget = { entry: FileEntry; side: PaneSide };

const TextEditor = lazy(() => import("./components/TextEditor"));

export default function App() {
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [localEntries, setLocalEntries] = useState<FileEntry[]>([]);
  const [remoteEntries, setRemoteEntries] = useState<FileEntry[]>([]);
  const [selectedLocal, setSelectedLocal] = useState<FileEntry[]>([]);
  const [selectedRemote, setSelectedRemote] = useState<FileEntry[]>([]);
  const [comparisonEnabled, setComparisonEnabled] = useState(false);
  const [syncMode, setSyncMode] = useState<SyncMode>("two_way");
  const [syncReviewOpen, setSyncReviewOpen] = useState(false);
  const [remoteTransferOpen, setRemoteTransferOpen] = useState(false);
  const [symlinkPolicy, setSymlinkPolicy] = useState<SymlinkPolicy>("skip");
  const [preserveMetadata, setPreserveMetadata] = useState(true);
  const [syncWarning, setSyncWarning] = useState<Record<PaneSide, string | null>>({
    local: null,
    remote: null,
  });
  const [connectionDialog, setConnectionDialog] = useState<ConnectionProfile | "new" | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [hostTrust, setHostTrust] = useState<{
    profile: ConnectionProfile;
    credential?: string;
    challenge: HostKeyChallenge;
  } | null>(null);
  const [loadingPane, setLoadingPane] = useState<PaneSide | null>(null);
  const [localGitBranch, setLocalGitBranch] = useState<string | null>(null);
  const [connectingId, setConnectingId] = useState<UUID | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editorFile, setEditorFile] = useState<EditableFile | null>(null);
  const [editorSide, setEditorSide] = useState<PaneSide | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorSaving, setEditorSaving] = useState(false);
  const [externalEdit, setExternalEdit] = useState<ExternalEditStarted | null>(null);
  const [externalEditChange, setExternalEditChange] = useState<ExternalEditChange | null>(null);
  const [externalEditSaving, setExternalEditSaving] = useState(false);
  const [nativeDrop, setNativeDrop] = useState<{
    destinationPath: string;
    count: number;
  } | null>(() =>
    !desktop && new URLSearchParams(window.location.search).get("dropPreview") === "1"
      ? { destinationPath: "/var/www/html", count: 2 }
      : null,
  );
  const [previewFile, setPreviewFile] = useState<PreviewFile | null>(null);
  const [previewLoading, setPreviewLoading] = useState<{ name: string; remote: boolean } | null>(null);
  const previewRequestId = useRef(0);
  const [sudoPrompt, setSudoPrompt] = useState<SudoPrompt | null>(null);
  const [entryCreation, setEntryCreation] = useState<EntryCreation | null>(null);
  const [pathJump, setPathJump] = useState<PaneSide | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [focusedPane, setFocusedPane] = useState<PaneSide>("remote");
  const [infoTarget, setInfoTarget] = useState<InfoTarget | null>(null);
  const [infoSaving, setInfoSaving] = useState(false);
  const [savedActions, setSavedActions] = useState<SavedAction[]>([]);
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  const [actionDialogOpen, setActionDialogOpen] = useState(false);
  const [remoteCommandResults, setRemoteCommandResults] = useState<{
    label: string;
    results: RemoteCommandResult[];
  } | null>(null);
  const [paneHidden, setPaneHidden] = useState<Record<PaneSide, boolean | null>>({
    local: null,
    remote: null,
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const initialized = useRef(false);
  const observedCompletedTransfers = useRef<Set<UUID>>(new Set());

  const tabs = useAppStore((state) => state.tabs);
  const activeTabId = useAppStore((state) => state.activeTabId);
  const transferCompletionVersion = useAppStore((state) => state.transferCompletionVersion);
  const addTab = useAppStore((state) => state.addTab);
  const closeTab = useAppStore((state) => state.closeTab);
  const setActiveTab = useAppStore((state) => state.setActiveTab);
  const updateTab = useAppStore((state) => state.updateTab);
  const setTransfers = useAppStore((state) => state.setTransfers);
  const updateTransfer = useAppStore((state) => state.updateTransfer);
  const setExpandTransfersOnNew = useAppStore((state) => state.setExpandTransfersOnNew);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const activeProfile = profiles.find((profile) => profile.id === activeTab?.profileId) ?? null;

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    void Promise.all([
      api.listProfiles(),
      api.listTransfers(),
      api.getPreferences(),
      api.listSavedActions(),
      api.listFavorites(),
    ])
      .then(async ([nextProfiles, nextTransfers, nextPreferences, nextActions, nextFavorites]) => {
        setProfiles(nextProfiles);
        setExpandTransfersOnNew(nextPreferences.expand_transfers_on_new);
        setTransfers(nextTransfers, { expandOnNew: false });
        setPreferences({
          ...nextPreferences,
          bookmark_order: nextPreferences.bookmark_order ?? {},
          profile_bandwidth_limits: nextPreferences.profile_bandwidth_limits ?? {},
          bandwidth_schedules: nextPreferences.bandwidth_schedules ?? [],
          sync_roots: nextPreferences.sync_roots ?? {},
        });
        setSavedActions(nextActions);
        setFavorites(nextFavorites);
        applyTheme(nextPreferences.theme);
        const restoredTabs = useAppStore.getState().tabs;
        const restoredActiveTabId = useAppStore.getState().activeTabId;
        let reconnectedActiveTabId: UUID | null = null;
        if (nextPreferences.restore_sessions && restoredTabs.length > 0) {
          const restoreOrder = [...restoredTabs].sort(
            (left, right) =>
              Number(right.id === restoredActiveTabId) - Number(left.id === restoredActiveTabId),
          );
          for (const restoredTab of restoreOrder) {
            useAppStore.getState().closeTab(restoredTab.id);
            const profile = nextProfiles.find((item) => item.id === restoredTab.profileId);
            if (profile) {
              await connect(profile, undefined, {
                localPath: restoredTab.localPath,
                remotePath: restoredTab.remotePath,
                layout: restoredTab.layout,
              });
              if (restoredTab.id === restoredActiveTabId) {
                reconnectedActiveTabId = useAppStore.getState().activeTabId;
              }
            }
          }
          if (reconnectedActiveTabId) setActiveTab(reconnectedActiveTabId);
        } else {
          for (const restoredTab of restoredTabs) {
            useAppStore.getState().closeTab(restoredTab.id);
          }
          if (!desktop && nextProfiles[0]) await connect(nextProfiles[0]);
        }
      })
      .catch((reason) => setError(errorMessage(reason)));
    let stop: (() => void) | undefined;
    void api.onTransferProgress(updateTransfer).then((unlisten) => {
      stop = unlisten;
    });
    return () => {
      stop?.();
    };
  }, [setExpandTransfersOnNew, setTransfers, updateTransfer]);

  useEffect(() => {
    let stop: (() => void) | undefined;
    void api
      .onExternalEditChanged(async (event) => {
        try {
          const change = await api.getExternalEditChange(event.edit_id);
          setExternalEditChange(change);
        } catch (reason) {
          setError(errorMessage(reason));
        }
      })
      .then((unlisten) => {
        stop = unlisten;
      });
    return () => stop?.();
  }, []);

  useEffect(() => {
    if (!desktop) return;
    if (!activeTab) {
      setNativeDrop(null);
      return;
    }
    let stop: (() => void) | undefined;
    let cancelled = false;
    const windowHandle = getCurrentWindow();
    void windowHandle
      .onDragDropEvent(({ payload }) => {
        if (payload.type === "leave") {
          setNativeDrop(null);
          return;
        }
        const position = payload.position;
        void windowHandle.scaleFactor().then((scale) => {
          const element = document.elementFromPoint(position.x / scale, position.y / scale);
          const pane = element?.closest<HTMLElement>('[data-pane-side="remote"]');
          if (!pane) {
            setNativeDrop(null);
            return;
          }
          const folder = element?.closest<HTMLElement>("[data-drop-folder]");
          const destinationPath =
            folder?.dataset.dropFolder || pane.dataset.panePath || activeTab.remotePath;
          if (payload.type === "drop") {
            setNativeDrop(null);
            void uploadNativeDrop(payload.paths, destinationPath);
          } else {
            setNativeDrop((current) => ({
              destinationPath,
              count: payload.type === "enter" ? payload.paths.length : current?.count ?? 0,
            }));
          }
        });
      })
      .then((unlisten) => {
        if (cancelled) unlisten();
        else stop = unlisten;
      });
    return () => {
      cancelled = true;
      stop?.();
      setNativeDrop(null);
    };
  }, [activeTab?.id, activeTab?.remotePath]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const isMod = event.metaKey || event.ctrlKey;
      const isFindFiles =
        isMod &&
        event.shiftKey &&
        !event.altKey &&
        (event.code === "KeyF" || event.key.toLowerCase() === "f");
      if (!isFindFiles) return;
      if (!activeTabId || editorOpen) return;
      // Open even when focus is in the pane filter; keep editor ⌘F for CodeMirror.
      event.preventDefault();
      event.stopPropagation();
      setSearchOpen(true);
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [activeTabId, editorOpen]);

  useEffect(() => {
    if (!activeTab) {
      setLocalEntries([]);
      setRemoteEntries([]);
      setLocalGitBranch(null);
      return;
    }
    void loadPane("local", activeTab.localPath);
    void loadPane("remote", activeTab.remotePath);
  }, [activeTab?.id]);

  useEffect(() => {
    const transfers = useAppStore.getState().transfers;
    const newlyCompleted = transfers.filter(
      (job) => job.state === "completed" && !observedCompletedTransfers.current.has(job.id),
    );
    for (const job of transfers) {
      if (job.state === "completed") observedCompletedTransfers.current.add(job.id);
    }
    if (!activeTab || newlyCompleted.length === 0) return;
    const relevant = newlyCompleted.filter((job) => job.profile_id === activeTab.profileId);
    if (relevant.some((job) => job.direction === "upload")) {
      void loadPane("remote", activeTab.remotePath);
    }
    if (relevant.some((job) => job.direction === "download")) {
      void loadPane("local", activeTab.localPath);
    }
    if (
      relevant.some(
        (job) =>
          job.direction === "remote_to_remote" &&
          (!job.destination_session_id || job.destination_session_id === activeTab.id),
      )
    ) {
      void loadPane("remote", activeTab.remotePath);
    }
  }, [
    transferCompletionVersion,
    activeTab?.id,
    activeTab?.localPath,
    activeTab?.remotePath,
  ]);

  async function connect(
    profile: ConnectionProfile,
    credential?: string,
    paths?: { localPath?: string; remotePath?: string; layout?: SessionTab["layout"] },
  ) {
    setConnectingId(profile.id);
    setError(null);
    try {
      const result = await api.connectProfile(profile.id, credential);
      if (result.status === "needs_host_trust") {
        setHostTrust({ profile, credential, challenge: result.challenge });
        return;
      }
      if (result.status === "needs_credential") {
        setConnectionDialog(profile);
        return;
      }
      const localPath = paths?.localPath ?? (await api.defaultLocalPath());
      const tab: SessionTab = {
        id: result.session_id,
        profileId: profile.id,
        label: profile.label,
        host: profile.host,
        protocol: profile.protocol,
        localPath,
        remotePath: paths?.remotePath ?? profile.initial_remote_path,
        layout: paths?.layout ?? preferences?.default_layout ?? "dual_pane",
        connected: true,
      };
      addTab(tab);
      setConnectionDialog(null);
      setSidebarCollapsed(true);
    } catch (reason) {
      const appError = reason as AppError;
      if (
        appError.code === "authentication_failed" ||
        (appError.code === "not_found" && profile.auth.kind === "private_key")
      ) {
        setConnectionDialog(profile);
      }
      setError(errorMessage(reason));
    } finally {
      setConnectingId(null);
    }
  }

  async function refreshLocalGitBranch(path: string) {
    try {
      setLocalGitBranch(await api.getLocalGitBranch(path));
    } catch {
      setLocalGitBranch(null);
    }
  }

  async function loadPane(side: PaneSide, path: string, sessionId?: UUID, selectPath?: string) {
    const tabId = sessionId ?? useAppStore.getState().activeTabId;
    if (!tabId) return;
    setLoadingPane(side);
    setError(null);
    try {
      const entries =
        side === "local"
          ? await api.listLocal(path)
          : await api.listRemote(tabId, path);
      const normalized = entries.map((entry) =>
        entry.kind === "directory" ? { ...entry, size: null } : entry,
      );
      const selected = selectPath
        ? normalized.find((entry) => entry.path === selectPath) ?? null
        : null;
      if (side === "local") {
        setLocalEntries(normalized);
        setSelectedLocal(selected ? [selected] : []);
        void refreshLocalGitBranch(path);
      } else {
        setRemoteEntries(normalized);
        setSelectedRemote(selected ? [selected] : []);
      }
    } catch (reason) {
      if (side === "local") setLocalGitBranch(null);
      setError(errorMessage(reason));
    } finally {
      setLoadingPane(null);
    }
  }

  async function navigate(side: PaneSide, path: string, sessionId?: UUID, selectPath?: string) {
    const tabId = sessionId ?? useAppStore.getState().activeTabId;
    if (!tabId) return;
    updateTab(tabId, side === "local" ? { localPath: path } : { remotePath: path });
    await loadPane(side, path, tabId, selectPath);
    const tab = useAppStore.getState().tabs.find((item) => item.id === tabId);
    const roots = tab ? preferences?.sync_roots?.[tab.profileId] : null;
    const sourceRoot = roots && (side === "local" ? roots.local_root : roots.remote_root);
    const normalizedRoot = sourceRoot?.replace(/[\\/]+$/, "") ?? "";
    const withinRoot =
      path === normalizedRoot ||
      path.startsWith(`${normalizedRoot}${side === "remote" ? "/" : path.includes("\\") ? "\\" : "/"}`);
    if (!tab || !roots?.enabled || !normalizedRoot || !withinRoot) return;
    const otherSide: PaneSide = side === "local" ? "remote" : "local";
    const targetRoot = side === "local" ? roots.remote_root : roots.local_root;
    const relative = path
      .slice(normalizedRoot.length)
      .replace(/^[\\/]+/, "");
    const target = relative ? joinPath(targetRoot, relative, otherSide === "remote") : targetRoot;
    try {
      const entries =
        otherSide === "local" ? await api.listLocal(target) : await api.listRemote(tabId, target);
      updateTab(tabId, otherSide === "local" ? { localPath: target } : { remotePath: target });
      const normalized = entries.map((entry) =>
        entry.kind === "directory" ? { ...entry, size: null } : entry,
      );
      if (otherSide === "local") {
        setLocalEntries(normalized);
        setSelectedLocal([]);
        void refreshLocalGitBranch(target);
      } else {
        setRemoteEntries(normalized);
        setSelectedRemote([]);
      }
      setSyncWarning((value) => ({ ...value, [otherSide]: null }));
    } catch {
      setSyncWarning((value) => ({
        ...value,
        [otherSide]: `Synchronized path does not exist: ${target}`,
      }));
    }
  }

  async function openSearchMatch(side: PaneSide, match: SearchMatch) {
    setSearchOpen(false);
    setFocusedPane(side);
    if (match.kind === "directory") {
      await navigate(side, match.path);
      return;
    }
    await navigate(side, match.parent_path, undefined, match.path);
  }

  async function browseFolder(side: PaneSide) {
    if (!activeTab) return;
    setError(null);
    if (side === "remote") {
      setPathJump("remote");
      return;
    }
    try {
      const selected = await api.pickDirectory(activeTab.localPath);
      if (selected) await navigate("local", selected);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  async function revealInFileManager(path: string) {
    setError(null);
    try {
      await api.revealInFileManager(path);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  async function addTransfer(
    direction: "upload" | "download",
    entry?: FileEntry | null,
    destinationOverride?: string,
  ) {
    if (!activeTab || !activeProfile) return;
    const selected = entry ? [entry] : direction === "upload" ? selectedLocal : selectedRemote;
    const transferable = selected.filter(
      (item) =>
        item.kind === "file" ||
        item.kind === "directory" ||
        (item.kind === "symlink" && symlinkPolicy !== "skip"),
    );
    const skippedSymlinks = selected.filter(
      (item) => item.kind === "symlink" && symlinkPolicy === "skip",
    ).length;
    if (transferable.length === 0) {
      setError(
        skippedSymlinks > 0
          ? `Skipped ${skippedSymlinks} symbolic link${skippedSymlinks === 1 ? "" : "s"} by policy`
          : "Select a file or folder to transfer",
      );
      return;
    }
    setError(null);
    try {
      const destinationBase =
        destinationOverride ??
        (direction === "upload" ? activeTab.remotePath : activeTab.localPath);
      const queued: TransferJob[] = [];
      for (const selectedEntry of transferable) {
        if (selectedEntry.kind === "directory") {
          queued.push(...await api.enqueueDirectoryTransfer({
            profileId: activeProfile.id,
            direction,
            sourcePath: selectedEntry.path,
            destinationPath: destinationBase,
            conflictPolicy: "ask",
            mode: "include_root",
            symlinkPolicy,
            preserveModifiedTime: preserveMetadata,
            preservePermissions: preserveMetadata,
          }));
        } else {
          queued.push(await api.enqueueTransfer({
            profileId: activeProfile.id,
            direction,
            sourcePath: selectedEntry.path,
            destinationPath: joinPath(destinationBase, selectedEntry.name, direction === "upload"),
            conflictPolicy: "ask",
            symlinkPolicy,
            preserveModifiedTime: preserveMetadata,
            preservePermissions: preserveMetadata,
          }));
        }
      }
      const currentTransfers = useAppStore.getState().transfers;
      setTransfers([
        ...queued,
        ...currentTransfers.filter((item) => !queued.some((job) => job.id === item.id)),
      ]);
      if (skippedSymlinks > 0) {
        setError(`Skipped ${skippedSymlinks} symbolic link${skippedSymlinks === 1 ? "" : "s"} by policy`);
      }
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  async function uploadNativeDrop(paths: string[], destinationPath: string) {
    if (!activeProfile || paths.length === 0) return;
    setError(null);
    try {
      const entries = await Promise.all(paths.map((path) => api.inspectLocalPath(path)));
      const queued: TransferJob[] = [];
      for (const entry of entries) {
        if (entry.kind === "directory") {
          queued.push(
            ...(await api.enqueueDirectoryTransfer({
              profileId: activeProfile.id,
              direction: "upload",
              sourcePath: entry.path,
              destinationPath,
              conflictPolicy: "ask",
              mode: "include_root",
              symlinkPolicy,
              preserveModifiedTime: preserveMetadata,
              preservePermissions: preserveMetadata,
            })),
          );
        } else if (entry.kind === "file" || (entry.kind === "symlink" && symlinkPolicy !== "skip")) {
          queued.push(
            await api.enqueueTransfer({
              profileId: activeProfile.id,
              direction: "upload",
              sourcePath: entry.path,
              destinationPath: joinPath(destinationPath, entry.name, true),
              conflictPolicy: "ask",
              symlinkPolicy,
              preserveModifiedTime: preserveMetadata,
              preservePermissions: preserveMetadata,
            }),
          );
        }
      }
      if (queued.length === 0) {
        setError("The dropped items are not transferable with the current symbolic-link policy");
        return;
      }
      setTransfers([
        ...queued,
        ...useAppStore
          .getState()
          .transfers.filter((item) => !queued.some((job) => job.id === item.id)),
      ]);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  async function queueRemoteTransfers(
    destination: SessionTab,
    routes: Array<{ sourcePath: string; destinationPath: string }>,
    conflictPolicy: ConflictPolicy,
  ) {
    if (!activeTab) return;
    const queued: TransferJob[] = [];
    for (const route of routes) {
      queued.push(
        await api.enqueueRemoteTransfer({
          sourceSessionId: activeTab.id,
          destinationSessionId: destination.id,
          sourcePath: route.sourcePath,
          destinationPath: route.destinationPath,
          conflictPolicy,
        }),
      );
    }
    const currentTransfers = useAppStore.getState().transfers;
    setTransfers([
      ...queued,
      ...currentTransfers.filter((item) => !queued.some((job) => job.id === item.id)),
    ]);
  }

  function handleDropTransfer(entry: FileEntry, sourceSide: PaneSide, destinationBase: string) {
    void addTransfer(
      sourceSide === "local" ? "upload" : "download",
      entry,
      destinationBase,
    );
  }

  async function moveEntry(side: PaneSide, entry: FileEntry, destinationFolder: string) {
    if (!activeTab) return;
    const remote = side === "remote";
    const destinationPath = joinPath(destinationFolder, entry.name, remote);
    setError(null);
    try {
      if (side === "local") {
        await api.renameLocalEntry(entry.path, destinationPath);
        setSelectedLocal([]);
        await loadPane("local", activeTab.localPath);
      } else {
        await api.renameRemoteEntry(activeTab.id, entry.path, destinationPath);
        setSelectedRemote([]);
        await loadPane("remote", activeTab.remotePath);
      }
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  function handlePaneDrop({
    entry,
    sourceSide,
    destinationPath,
    mode,
  }: {
    entry: FileEntry;
    sourceSide: PaneSide;
    destinationSide: PaneSide;
    destinationPath: string;
    mode: "transfer" | "move";
  }) {
    if (mode === "move") {
      void moveEntry(sourceSide, entry, destinationPath);
      return;
    }
    handleDropTransfer(entry, sourceSide, destinationPath);
  }

  async function handleRunSavedAction(action: SavedAction) {
    setError(null);
    try {
      const result = await runSavedAction(action, {
        tab: activeTab,
        navigate,
      });
      if (result.transfers?.length) {
        const currentTransfers = useAppStore.getState().transfers;
        setTransfers([
          ...result.transfers,
          ...currentTransfers.filter((item) => !result.transfers!.some((job) => job.id === item.id)),
        ]);
      }
      if (result.refreshLocal && activeTab) {
        void loadPane("local", activeTab.localPath);
      }
      if (result.refreshRemote && activeTab) {
        void loadPane("remote", activeTab.remotePath);
      }
      if (result.remoteCommandResults?.length) {
        setRemoteCommandResults({
          label: result.actionLabel ?? action.label,
          results: result.remoteCommandResults,
        });
      }
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  async function handleSaveAction(draft: {
    label: string;
    kind: SavedAction["kind"];
    localPath: string | null;
    remotePath: string | null;
    archiveFormat: SavedAction["archive_format"];
    commands: string[];
  }) {
    const now = new Date().toISOString();
    const action: SavedAction = {
      id: newSavedActionId(),
      label: draft.label,
      kind: draft.kind,
      local_path: draft.localPath,
      remote_path: draft.remotePath,
      archive_format: draft.archiveFormat ?? null,
      commands: draft.commands,
      created_at: now,
      updated_at: now,
    };
    const saved = await api.saveSavedAction(action);
    setSavedActions((items) =>
      [...items.filter((item) => item.id !== saved.id), saved].sort((left, right) =>
        left.label.localeCompare(right.label),
      ),
    );
  }

  async function handleDeleteSavedAction(action: SavedAction) {
    await api.deleteSavedAction(action.id);
    setSavedActions((items) => items.filter((item) => item.id !== action.id));
  }

  async function listDirectoryNames(side: PaneSide, directory: string) {
    try {
      const entries =
        side === "local"
          ? await api.listLocal(directory)
          : activeTab
            ? await api.listRemote(activeTab.id, directory)
            : [];
      return entries.filter((entry) => entry.kind === "directory").map((entry) => entry.name);
    } catch {
      return [];
    }
  }

  async function createEntry(name: string) {
    if (!activeTab || !entryCreation) return;
    const { side, directory, privileged } = entryCreation;
    const parentPath = side === "local" ? activeTab.localPath : activeTab.remotePath;
    const create = (password?: string) => {
      if (privileged) {
        return side === "local"
          ? api.createLocalEntryPrivileged(parentPath, name, directory, password)
          : api.createRemoteEntryPrivileged(activeTab.id, parentPath, name, directory, password);
      }
      return side === "local"
        ? api.createLocalEntry(parentPath, name, directory)
        : api.createRemoteEntry(activeTab.id, parentPath, name, directory);
    };
    try {
      await create();
    } catch (reason) {
      if (!privileged || (reason as AppError)?.code !== "authentication_failed") throw reason;
      const password = await requestSudoPassword(`${parentPath}/${name}`);
      if (password == null) return;
      await create(password);
    }
    setEntryCreation(null);
    await loadPane(side, parentPath);
  }

  async function removeSelected(side: PaneSide, privileged = false, entry?: FileEntry) {
    if (!activeTab) return;
    const selected = entry ? [entry] : side === "local" ? selectedLocal : selectedRemote;
    if (selected.length === 0) return;
    setError(null);
    try {
      const label =
        selected.length === 1 && selected[0]
          ? selected[0].name
          : `${selected.length} selected items`;
      if (!(await api.confirmDelete(label, selected.some((item) => item.kind === "directory")))) {
        return;
      }
      for (const item of selected) {
        const directory = item.kind === "directory";
        const remove = (password?: string) => {
          if (privileged) {
            return side === "local"
              ? api.deleteLocalEntryPrivileged(item.path, directory, password)
              : api.deleteRemoteEntryPrivileged(activeTab.id, item.path, directory, password);
          }
          return side === "local"
            ? api.deleteLocalEntry(item.path, directory)
            : api.deleteRemoteEntry(activeTab.id, item.path, directory);
        };
        try {
          await remove();
        } catch (reason) {
          if (!privileged || (reason as AppError)?.code !== "authentication_failed") throw reason;
          const password = await requestSudoPassword(item.path);
          if (password == null) return;
          await remove(password);
        }
      }
      if (side === "local") {
        setSelectedLocal([]);
        await loadPane("local", activeTab.localPath);
      } else {
        setSelectedRemote([]);
        await loadPane("remote", activeTab.remotePath);
      }
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  async function openFile(entry: FileEntry, side: PaneSide) {
    if (!activeTab || entry.kind !== "file") return;
    if (isImageFile(entry.name)) {
      const requestId = ++previewRequestId.current;
      setError(null);
      setPreviewLoading({ name: entry.name, remote: side === "remote" });
      try {
        const file =
          side === "remote"
            ? await api.readRemotePreview(activeTab.id, entry.path)
            : await api.readLocalPreview(entry.path);
        if (requestId !== previewRequestId.current) return;
        setPreviewFile(file);
      } catch (reason) {
        if (requestId !== previewRequestId.current) return;
        setError(errorMessage(reason));
      } finally {
        if (requestId === previewRequestId.current) setPreviewLoading(null);
      }
      return;
    }
    await openEditor(entry, side);
  }

  async function beginExternalEdit(entry: FileEntry) {
    if (!activeTab || entry.kind !== "file") return;
    if (externalEdit) {
      setError(`Finish the external edit of ${externalEdit.name} before opening another file`);
      return;
    }
    setError(null);
    try {
      const edit = await api.beginExternalEdit(activeTab.id, entry.path);
      setExternalEdit(edit);
      await api.openExternalEdit(edit.local_path);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  async function uploadExternalEdit() {
    if (!externalEditChange || !activeTab) return;
    setExternalEditSaving(true);
    setError(null);
    try {
      await api.commitExternalEdit(externalEditChange.edit_id);
      setExternalEditChange(null);
      await loadPane("remote", activeTab.remotePath);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setExternalEditSaving(false);
    }
  }

  async function stopExternalEdit() {
    if (!externalEdit) return;
    try {
      await api.endExternalEdit(externalEdit.edit_id);
      setExternalEdit(null);
      setExternalEditChange(null);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  function cancelPreviewLoading() {
    previewRequestId.current += 1;
    setPreviewLoading(null);
  }

  async function openEditor(entry: FileEntry, side: PaneSide) {
    if (!activeTab || entry.kind !== "file") return;
    setError(null);
    try {
      const file = side === "remote" ? await api.readRemoteFile(activeTab.id, entry.path) : await api.readLocalFile(entry.path);
      setEditorFile(file);
      setEditorSide(side);
      setEditorOpen(true);
    } catch (reason) { setError(errorMessage(reason)); }
  }

  function requestSudoPassword(path: string): Promise<string | null> {
    return new Promise((resolve) => setSudoPrompt({ path, resolve }));
  }

  async function openPrivilegedEditor(entry: FileEntry, side: PaneSide) {
    if (!activeTab || entry.kind !== "file") return;
    setError(null);
    try {
      const read = (password?: string) => side === "remote"
        ? api.readRemoteFilePrivileged(activeTab.id, entry.path, password)
        : api.readLocalFilePrivileged(entry.path, password);
      let file: EditableFile;
      try {
        file = await read();
      } catch (reason) {
        if ((reason as AppError)?.code !== "authentication_failed") throw reason;
        const password = await requestSudoPassword(entry.path);
        if (password == null) return;
        file = await read(password);
      }
      setEditorFile({ ...file, privileged: true });
      setEditorSide(side);
      setEditorOpen(true);
    } catch (reason) { setError(errorMessage(reason)); }
  }

  async function saveEditor(content: string) {
    if (!activeTab || !editorFile) return;
    setEditorSaving(true);
    try {
      if (editorFile.privileged) {
        const save = (password?: string) => editorSide === "remote"
          ? api.saveRemoteFilePrivileged(activeTab.id, editorFile.path, content, password)
          : api.saveLocalFilePrivileged(editorFile.path, content, password);
        try {
          await save();
        } catch (reason) {
          if ((reason as AppError)?.code !== "authentication_failed") throw reason;
          const password = await requestSudoPassword(editorFile.path);
          if (password == null) return;
          await save(password);
        }
      } else if (editorSide === "remote") await api.saveRemoteFile(activeTab.id, editorFile.path, content);
      else await api.saveLocalFile(editorFile.path, content);
      setEditorFile({ ...editorFile, content, size: new TextEncoder().encode(content).length });
      setEditorOpen(false);
      await loadPane(editorSide ?? "remote", editorSide === "remote" ? activeTab.remotePath : activeTab.localPath);
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setEditorSaving(false); }
  }

  async function handleProfileClick(profile: ConnectionProfile) {
    await connect(profile);
  }

  async function toggleFavorite(profile: ConnectionProfile) {
    setError(null);
    try {
      const saved = await api.saveProfile({
        ...profile,
        favorite: !profile.favorite,
        updated_at: new Date().toISOString(),
      });
      setProfiles((items) => orderProfiles([
        ...items.filter((item) => item.id !== saved.id),
        saved,
      ]));
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  function findBookmark(side: PaneSide, path: string, profileId: UUID | null) {
    const normalized = normalizeBookmarkPath(path, side === "remote");
    return findBookmarkForPath(favorites, side, normalized, profileId);
  }

  async function toggleBookmark(side: PaneSide) {
    if (!activeTab?.profileId) {
      setError("Connect to a server to bookmark folders");
      return;
    }
    setError(null);
    const path = side === "local" ? activeTab.localPath : activeTab.remotePath;
    const normalized = normalizeBookmarkPath(path, side === "remote");
    const existing = findBookmark(side, normalized, activeTab.profileId);
    try {
      if (existing) {
        await api.deleteFavorite(existing.id);
        setFavorites((items) => items.filter((item) => item.id !== existing.id));
        forgetBookmarkOrder(activeTab.profileId, existing.id);
        return;
      }
      const saved = await api.saveFavorite({
        id: crypto.randomUUID(),
        profile_id: activeTab.profileId,
        side,
        label: pathBasename(normalized, side === "remote"),
        path: normalized,
      });
      setFavorites((items) =>
        [...items.filter((item) => item.id !== saved.id), saved].sort((left, right) =>
          left.label.localeCompare(right.label),
        ),
      );
      appendBookmarkOrder(activeTab.profileId, saved.id);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  async function removeBookmark(bookmark: Favorite) {
    setError(null);
    try {
      await api.deleteFavorite(bookmark.id);
      setFavorites((items) => items.filter((item) => item.id !== bookmark.id));
      if (bookmark.profile_id) forgetBookmarkOrder(bookmark.profile_id, bookmark.id);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  function appendBookmarkOrder(profileId: UUID, bookmarkId: string) {
    setPreferences((current) => {
      if (!current) return current;
      const existing = current.bookmark_order[profileId] ?? [];
      if (existing.includes(bookmarkId)) return current;
      const next = {
        ...current,
        bookmark_order: withProfileOrder(current.bookmark_order, profileId, [
          ...existing,
          bookmarkId,
        ]),
      };
      void api.savePreferences(next);
      return next;
    });
  }

  function forgetBookmarkOrder(profileId: UUID, bookmarkId: string) {
    setPreferences((current) => {
      if (!current) return current;
      const existing = current.bookmark_order[profileId];
      if (!existing?.includes(bookmarkId)) return current;
      const next = {
        ...current,
        bookmark_order: withProfileOrder(
          current.bookmark_order,
          profileId,
          existing.filter((id) => id !== bookmarkId),
        ),
      };
      void api.savePreferences(next);
      return next;
    });
  }

  async function openBookmark(bookmark: Favorite) {
    setError(null);
    try {
      if (!bookmark.profile_id) {
        setError("This bookmark is missing its connection");
        return;
      }
      const profile = profiles.find((item) => item.id === bookmark.profile_id);
      if (!profile) {
        setError("The connection for this bookmark was removed");
        return;
      }
      const existing = useAppStore.getState().tabs.find((tab) => tab.profileId === profile.id);
      if (existing) {
        setActiveTab(existing.id);
        await navigate(bookmark.side, bookmark.path, existing.id);
      } else {
        await connect(
          profile,
          undefined,
          bookmark.side === "local"
            ? { localPath: bookmark.path }
            : { remotePath: bookmark.path },
        );
      }
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  async function closeSession(tab: SessionTab) {
    closeTab(tab.id);
    try {
      await api.disconnectSession(tab.id);
    } catch {
      // The UI can close an already-disconnected session without another alert.
    }
  }

  async function batchPermissions() {
    if (!activeTab) return;
    const selected = focusedPane === "local" ? selectedLocal : selectedRemote;
    if (selected.length === 0) return;
    const value = window.prompt("Permissions (octal)", "755");
    if (!value || !/^[0-7]{3,4}$/.test(value)) return;
    const permissions = Number.parseInt(value, 8);
    try {
      for (const entry of selected) {
        if (focusedPane === "local") {
          await api.setLocalPermissions(entry.path, permissions);
        } else {
          await api.setRemotePermissions(activeTab.id, entry.path, permissions);
        }
      }
      await loadPane(
        focusedPane,
        focusedPane === "local" ? activeTab.localPath : activeTab.remotePath,
      );
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  async function batchPackage() {
    if (!activeTab) return;
    const selected = (focusedPane === "local" ? selectedLocal : selectedRemote).filter(
      (entry) => entry.kind === "directory",
    );
    if (selected.length === 0) {
      setError("Select one or more folders to package");
      return;
    }
    try {
      for (const entry of selected) {
        if (focusedPane === "local") {
          await api.packageLocalDirectory(entry.path, "zip");
        } else {
          await api.packageRemoteDirectory(activeTab.id, entry.path, "zip");
        }
      }
      await loadPane(
        focusedPane,
        focusedPane === "local" ? activeTab.localPath : activeTab.remotePath,
      );
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  const comparedEntries = useMemo(
    () => compareDirectories(localEntries, remoteEntries),
    [localEntries, remoteEntries],
  );
  const comparisonByName = useMemo(
    () => Object.fromEntries(comparedEntries.map((item) => [item.name, item.status])),
    [comparedEntries],
  );
  const syncActions: SyncAction[] = useMemo(
    () => planSynchronization(comparedEntries, syncMode),
    [comparedEntries, syncMode],
  );

  async function executeSynchronization(actions: SyncAction[]) {
    if (!activeTab) return;
    setSyncReviewOpen(false);
    setError(null);
    try {
      for (const action of actions) {
        if (action.kind === "upload" || action.kind === "download") {
          await addTransfer(action.kind, action.entry);
        } else if (action.kind === "delete_local") {
          await api.deleteLocalEntry(action.entry.path, action.entry.kind === "directory");
        } else {
          await api.deleteRemoteEntry(
            activeTab.id,
            action.entry.path,
            action.entry.kind === "directory",
          );
        }
      }
      setTransfers(await api.listTransfers());
      await Promise.all([
        loadPane("local", activeTab.localPath),
        loadPane("remote", activeTab.remotePath),
      ]);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  return (
    <>
      <AppUpdater />
      <FilePaneDragGhost />
      {settingsOpen && preferences ? (
      <SettingsView
        value={preferences}
        profiles={profiles}
        onConfigurationImported={async () => {
          const [nextProfiles, nextFavorites, nextActions] = await Promise.all([
            api.listProfiles(),
            api.listFavorites(),
            api.listSavedActions(),
          ]);
          setProfiles(orderProfiles(nextProfiles));
          setFavorites(nextFavorites);
          setSavedActions(nextActions);
        }}
        onBack={() => setSettingsOpen(false)}
        onChange={(next) => {
          setPreferences(next);
          setExpandTransfersOnNew(next.expand_transfers_on_new);
          applyTheme(next.theme);
          void api.savePreferences(next);
        }}
      />
    ) : (
    <div className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <div
        className="window-drag-region"
        data-tauri-drag-region
        onMouseDown={(event) => {
          if (desktop && event.button === 0) void getCurrentWindow().startDragging();
        }}
      >
        <span data-tauri-drag-region>Siftlane</span>
      </div>
      <Sidebar
        profiles={profiles}
        favorites={favorites}
        bookmarkOrder={preferences?.bookmark_order ?? {}}
        activeProfileId={activeTab?.profileId ?? null}
        activeLocalPath={activeTab?.localPath ?? null}
        activeRemotePath={activeTab?.remotePath ?? null}
        connectingId={connectingId}
        collapsed={sidebarCollapsed}
        onProfileClick={handleProfileClick}
        onEditProfile={(profile) => setConnectionDialog(profile)}
        onToggleFavorite={toggleFavorite}
        onOpenBookmark={(bookmark) => void openBookmark(bookmark)}
        onRemoveBookmark={(bookmark) => void removeBookmark(bookmark)}
        onReorderBookmarks={(profileId, orderedIds) => {
          setPreferences((current) => {
            const base = current ?? {
              theme: "system" as const,
              default_layout: "dual_pane" as const,
              show_hidden_files: true,
              diagnostics_enabled: false,
              global_parallel_transfers: 3,
              per_host_parallel_transfers: 2,
              expand_transfers_on_new: true,
              automatic_retry_limit: 3,
              connect_timeout_seconds: 15,
              response_timeout_seconds: 30,
              keepalive_seconds: 30,
              bookmark_order: {},
              restore_sessions: true,
              global_upload_limit_bps: null,
              global_download_limit_bps: null,
              profile_bandwidth_limits: {},
              bandwidth_schedules: [],
              temporary_bandwidth_limit: null,
              sync_roots: {},
            };
            const next = {
              ...base,
              bookmark_order: withProfileOrder(base.bookmark_order, profileId, orderedIds),
            };
            void api.savePreferences(next);
            return next;
          });
        }}
        onToggleCollapsed={() => setSidebarCollapsed((value) => !value)}
        onNew={() => setConnectionDialog("new")}
        onSettings={() => setSettingsOpen(true)}
      />
      <main className="workspace">
        <SessionTabs
          tabs={tabs}
          visible={tabs.length > 0}
          activeId={activeTabId}
          actions={savedActions}
          onSelect={setActiveTab}
          onClose={closeSession}
          onNew={() => setConnectionDialog("new")}
          onRunAction={(action) => void handleRunSavedAction(action)}
          onAddAction={() => setActionDialogOpen(true)}
          onDeleteAction={(action) => void handleDeleteSavedAction(action).catch((reason) => setError(errorMessage(reason)))}
        />
        {error && (
          <div className="error-banner" role="alert">
            <CircleAlert size={16} />
            <span>{error}</span>
            <button aria-label="Dismiss error" onClick={() => setError(null)}><X size={15} /></button>
          </div>
        )}
        {activeTab ? (
          <>
            <ConnectionHeader
              tab={activeTab}
              onSearch={() => setSearchOpen(true)}
              onDisconnect={() => void closeSession(activeTab)}
              onToggleLayout={() => {
                updateTab(activeTab.id, {
                  layout: activeTab.layout === "dual_pane" ? "remote_focused" : "dual_pane",
                });
              }}
            />
            <div className="sync-toolbar">
              <div className={`sync-toolbar-item${comparisonEnabled ? " active" : ""}`}>
                <button
                  type="button"
                  onClick={() => setComparisonEnabled((value) => !value)}
                >
                  {comparisonEnabled ? "Comparison on" : "Compare directories"}
                </button>
                <InfoTooltip label="Compare directories">
                  Highlights differences between the open local and remote directories by
                  matching names, then comparing type, size, and modification time. Nothing
                  is changed until you synchronize.
                </InfoTooltip>
              </div>
              <div className="sync-toolbar-item">
                <button type="button" onClick={() => setSyncReviewOpen(true)}>
                  Synchronize…
                </button>
                <InfoTooltip label="Synchronize">
                  Opens a review checklist of proposed uploads, downloads, and deletions.
                  Choose two-way, upload mirror, or download mirror, then exclude any
                  actions before running them.
                </InfoTooltip>
              </div>
              <div className="sync-toolbar-item">
                <label>
                  <input
                    type="checkbox"
                    checked={!!activeProfile && !!preferences?.sync_roots?.[activeProfile.id]?.enabled}
                    onChange={(event) => {
                      if (!activeProfile || !activeTab || !preferences) return;
                      const next = {
                        ...preferences,
                        sync_roots: {
                          ...preferences.sync_roots,
                          [activeProfile.id]: {
                            local_root: activeTab.localPath,
                            remote_root: activeTab.remotePath,
                            enabled: event.target.checked,
                          },
                        },
                      };
                      setPreferences(next);
                      void api.savePreferences(next);
                    }}
                  />
                  Synchronized browsing
                </label>
                <InfoTooltip label="Synchronized browsing">
                  Saves the current local and remote folders as this profile's root pair.
                  Navigating below either root follows the same relative path in the other
                  pane when that path exists.
                </InfoTooltip>
              </div>
              <div className="sync-toolbar-item">
                <label>
                  Symlinks
                  <select
                    value={symlinkPolicy}
                    onChange={(event) => setSymlinkPolicy(event.target.value as SymlinkPolicy)}
                  >
                    <option value="skip">Skip with warning</option>
                    <option value="copy_link">Copy link</option>
                    <option value="dereference">Dereference</option>
                  </select>
                </label>
                <InfoTooltip label="Symlinks">
                  Controls how symbolic links are transferred: skip them with a warning,
                  copy the link itself when supported, or dereference and transfer the
                  linked contents.
                </InfoTooltip>
              </div>
              <div className="sync-toolbar-item">
                <label>
                  <input
                    type="checkbox"
                    checked={preserveMetadata}
                    onChange={(event) => setPreserveMetadata(event.target.checked)}
                  />
                  Preserve metadata
                </label>
                <InfoTooltip label="Preserve metadata">
                  Restores modification times and POSIX permissions on download when the
                  server reports them, and restores permissions on upload when the remote
                  protocol supports chmod.
                </InfoTooltip>
              </div>
              <div className="sync-toolbar-item">
                <button
                  type="button"
                  disabled={(focusedPane === "local" ? selectedLocal : selectedRemote).length === 0}
                  onClick={() => void batchPermissions()}
                >
                  Permissions…
                </button>
                <InfoTooltip label="Permissions">
                  Sets an octal permission mode on every selected item in the focused pane
                  (for example 755 or 644).
                </InfoTooltip>
              </div>
              <div className="sync-toolbar-item">
                <button
                  type="button"
                  disabled={(focusedPane === "local" ? selectedLocal : selectedRemote).length === 0}
                  onClick={() => void batchPackage()}
                >
                  Package
                </button>
                <InfoTooltip label="Package">
                  Creates a zip archive of each selected folder in the focused pane, next to
                  that folder.
                </InfoTooltip>
              </div>
              <div className="sync-toolbar-item">
                <button
                  type="button"
                  disabled={(focusedPane === "local" ? selectedLocal : selectedRemote).length === 0}
                  onClick={() => void removeSelected(focusedPane)}
                >
                  Delete
                </button>
                <InfoTooltip label="Delete">
                  Deletes the selected files and folders in the focused pane after
                  confirmation. This cannot be undone.
                </InfoTooltip>
              </div>
              <div className="sync-toolbar-item">
                <button
                  type="button"
                  disabled={
                    selectedRemote.every((entry) => entry.kind !== "file") ||
                    !tabs.some((tab) => tab.id !== activeTab.id && tab.connected)
                  }
                  onClick={() => setRemoteTransferOpen(true)}
                >
                  <ArrowRightLeft size={14} />
                  Copy to session…
                </button>
                <InfoTooltip label="Copy to session">
                  Copies selected remote files to another open connected session. Review the
                  source and destination routes and conflict handling before the transfer is
                  queued.
                </InfoTooltip>
              </div>
              {comparisonEnabled && (
                <span>{comparedEntries.filter((item) => item.status !== "same").length} differences</span>
              )}
            </div>
            <section
              className={`browser-grid ${activeTab.layout === "remote_focused" ? "remote-only" : "dual-pane"}`}
            >
              <div
                className="browser-slot local-slot"
                aria-hidden={activeTab.layout === "remote_focused"}
                inert={activeTab.layout === "remote_focused" ? true : undefined}
              >
                <FilePane
                  title="Local"
                  side="local"
                  path={activeTab.localPath}
                  gitBranch={localGitBranch}
                  entries={localEntries}
                  selected={selectedLocal}
                  loading={loadingPane === "local"}
                  showHidden={paneHidden.local ?? preferences?.show_hidden_files ?? true}
                  onFocus={() => setFocusedPane("local")}
                  onSelectionChange={setSelectedLocal}
                  comparisonByName={comparisonEnabled ? comparisonByName : undefined}
                  warning={syncWarning.local}
                  onNavigate={(path) => navigate("local", path)}
                  onBrowse={() => void browseFolder("local")}
                  onRefresh={() => loadPane("local", activeTab.localPath)}
                  onToggleHidden={() => setPaneHidden((value) => ({ ...value, local: !(value.local ?? preferences?.show_hidden_files ?? true) }))}
                  onCreateFile={() => setEntryCreation({ side: "local", directory: false, privileged: false })}
                  onCreateDirectory={() => setEntryCreation({ side: "local", directory: true, privileged: false })}
                  onRemove={(entry) => void removeSelected("local", false, entry)}
                  onOpenFile={(entry) => void openFile(entry, "local")}
                  onShowInfo={(entry) => setInfoTarget({ entry, side: "local" })}
                  onRevealInFileManager={(path) => void revealInFileManager(path)}
                  transferLabel="Upload"
                  onTransfer={(entry) => void addTransfer("upload", entry)}
                  onPaneDrop={handlePaneDrop}
                  bookmarked={!!findBookmark("local", activeTab.localPath, activeTab.profileId)}
                  onToggleBookmark={() => void toggleBookmark("local")}
                />
              </div>
              <div
                className="browser-slot transfer-slot"
                aria-hidden={activeTab.layout === "remote_focused"}
                inert={activeTab.layout === "remote_focused" ? true : undefined}
              >
                <div className="transfer-controls" aria-label="Transfer selected item">
                  <button title="Upload selected" onClick={() => void addTransfer("upload")} disabled={selectedLocal.length === 0}>
                    <ArrowRight size={17} />
                  </button>
                  <button title="Download selected" onClick={() => void addTransfer("download")} disabled={selectedRemote.length === 0}>
                    <ArrowLeft size={17} />
                  </button>
                </div>
              </div>
              <div className="browser-slot remote-slot">
                <FilePane
                  title="Remote"
                  subtitle={activeProfile?.host}
                  side="remote"
                  path={activeTab.remotePath}
                  entries={remoteEntries}
                  selected={selectedRemote}
                  loading={loadingPane === "remote"}
                  showHidden={paneHidden.remote ?? preferences?.show_hidden_files ?? true}
                  onFocus={() => setFocusedPane("remote")}
                  onSelectionChange={setSelectedRemote}
                  comparisonByName={comparisonEnabled ? comparisonByName : undefined}
                  warning={syncWarning.remote}
                  onNavigate={(path) => navigate("remote", path)}
                  onBrowse={() => void browseFolder("remote")}
                  onRefresh={() => loadPane("remote", activeTab.remotePath)}
                  onToggleHidden={() => setPaneHidden((value) => ({ ...value, remote: !(value.remote ?? preferences?.show_hidden_files ?? true) }))}
                  onCreateFile={() => setEntryCreation({ side: "remote", directory: false, privileged: false })}
                  onCreateDirectory={() => setEntryCreation({ side: "remote", directory: true, privileged: false })}
                  onCreateFilePrivileged={() => setEntryCreation({ side: "remote", directory: false, privileged: true })}
                  onCreateDirectoryPrivileged={() => setEntryCreation({ side: "remote", directory: true, privileged: true })}
                  onRemove={(entry) => void removeSelected("remote", false, entry)}
                  onRemovePrivileged={(entry) => void removeSelected("remote", true, entry)}
                  onOpenFile={(entry) => void openFile(entry, "remote")}
                  onOpenPrivileged={(entry) => void openPrivilegedEditor(entry, "remote")}
                  onEditExternal={(entry) => void beginExternalEdit(entry)}
                  onShowInfo={(entry) => setInfoTarget({ entry, side: "remote" })}
                  transferLabel="Download"
                  onTransfer={(entry) => void addTransfer("download", entry)}
                  onPaneDrop={handlePaneDrop}
                  nativeDropActive={!!nativeDrop}
                  nativeDropCount={nativeDrop?.count ?? 0}
                  nativeDropDestination={nativeDrop?.destinationPath}
                  bookmarked={!!findBookmark("remote", activeTab.remotePath, activeTab.profileId)}
                  onToggleBookmark={() => void toggleBookmark("remote")}
                />
              </div>
            </section>
            {externalEdit && (
              <div className="external-edit-session" role="status">
                <span>
                  <ExternalLink size={14} />
                  Watching <strong>{externalEdit.name}</strong> for external saves
                </span>
                <button onClick={() => void stopExternalEdit()}>Stop editing</button>
              </div>
            )}
            <TransferPanel />
            {remoteTransferOpen && (
              <RemoteTransferDialog
                source={activeTab}
                destinations={tabs.filter((tab) => tab.id !== activeTab.id && tab.connected)}
                entries={selectedRemote.filter((entry) => entry.kind === "file")}
                onClose={() => setRemoteTransferOpen(false)}
                onConfirm={queueRemoteTransfers}
              />
            )}
          </>
        ) : (
          <Welcome profiles={profiles} onConnect={handleProfileClick} onNew={() => setConnectionDialog("new")} />
        )}
      </main>
      {infoTarget && activeTab && (
        <FileInfoDialog
          entry={
            (infoTarget.side === "local" ? localEntries : remoteEntries).find(
              (entry) => entry.path === infoTarget.entry.path,
            ) ?? infoTarget.entry
          }
          canEditPermissions={
            infoTarget.side === "local"
              ? infoTarget.entry.permissions != null
              : activeProfile?.protocol === "sftp" && infoTarget.entry.permissions != null
          }
          saving={infoSaving}
          onClose={() => setInfoTarget(null)}
          onResolveDirectorySize={
            infoTarget.entry.kind === "directory"
              ? (path) =>
                  infoTarget.side === "local"
                    ? api.getLocalDirectorySize(path)
                    : api.getRemoteDirectorySize(activeTab.id, path)
              : undefined
          }
          onSavePermissions={async (permissions) => {
            setInfoSaving(true);
            try {
              if (infoTarget.side === "local") {
                await api.setLocalPermissions(infoTarget.entry.path, permissions);
                await loadPane("local", activeTab.localPath);
              } else {
                await api.setRemotePermissions(activeTab.id, infoTarget.entry.path, permissions);
                await loadPane("remote", activeTab.remotePath);
              }
              setInfoTarget({
                ...infoTarget,
                entry: { ...infoTarget.entry, permissions },
              });
            } catch (reason) {
              setError(errorMessage(reason));
              throw reason;
            } finally {
              setInfoSaving(false);
            }
          }}
        />
      )}
      {entryCreation && (
        <NewEntryDialog
          directory={entryCreation.directory}
          side={entryCreation.side}
          privileged={entryCreation.privileged}
          onClose={() => setEntryCreation(null)}
          onSubmit={createEntry}
        />
      )}
      {pathJump && activeTab && (
        <GoToPathDialog
          side={pathJump}
          initialPath={pathJump === "local" ? activeTab.localPath : activeTab.remotePath}
          onClose={() => setPathJump(null)}
          onSubmit={(path) => navigate(pathJump, path)}
          onListDirectories={(directory) => listDirectoryNames(pathJump, directory)}
        />
      )}
      {searchOpen && activeTab && (
        <SearchDialog
          initialSide={focusedPane}
          localRoot={activeTab.localPath}
          remoteRoot={activeTab.remotePath}
          sessionId={activeTab.id}
          remoteAvailable
          onClose={() => setSearchOpen(false)}
          onOpenMatch={(side, match) => void openSearchMatch(side, match)}
        />
      )}
      {actionDialogOpen && (
        <SavedActionDialog
          initialLocalPath={activeTab?.localPath ?? ""}
          initialRemotePath={activeTab?.remotePath ?? "/"}
          onClose={() => setActionDialogOpen(false)}
          onSubmit={handleSaveAction}
          onListLocalDirectories={(directory) => listDirectoryNames("local", directory)}
          onListRemoteDirectories={(directory) => listDirectoryNames("remote", directory)}
        />
      )}
      {remoteCommandResults && (
        <RemoteCommandsResultDialog
          label={remoteCommandResults.label}
          results={remoteCommandResults.results}
          onClose={() => setRemoteCommandResults(null)}
        />
      )}
      {syncReviewOpen && (
        <SyncReviewDialog
          mode={syncMode}
          actions={syncActions}
          onModeChange={setSyncMode}
          onClose={() => setSyncReviewOpen(false)}
          onConfirm={(actions) => void executeSynchronization(actions)}
        />
      )}
      {connectionDialog && (
        <ConnectionDialog
          existing={connectionDialog === "new" ? null : connectionDialog}
          profiles={profiles}
          folders={[
            ...new Set(
              profiles
                .map((profile) => profile.folder)
                .filter((folder): folder is string => !!folder),
            ),
          ].sort((left, right) => left.localeCompare(right))}
          onClose={() => setConnectionDialog(null)}
          onSubmit={async (profile, credential) => {
            const saved = await api.saveProfile(profile);
            setProfiles((items) => orderProfiles([...items.filter((item) => item.id !== saved.id), saved]));
            await connect(saved, credential || undefined);
          }}
        />
      )}
      {hostTrust && (
        <HostKeyDialog
          value={hostTrust.challenge}
          onClose={() => setHostTrust(null)}
          onDecision={async (accept) => {
            const pending = hostTrust;
            setHostTrust(null);
            const result = await api.trustHostKey(pending.challenge.challenge_id, accept);
            if (!result) return;
            if (result.status === "needs_host_trust") {
              setHostTrust({ profile: pending.profile, credential: pending.credential, challenge: result.challenge });
              return;
            }
            if (result.status === "needs_credential") {
              setConnectionDialog(pending.profile);
              return;
            }
            const localPath = await api.defaultLocalPath();
            addTab({
              id: result.session_id,
              profileId: pending.profile.id,
              label: pending.profile.label,
              host: pending.profile.host,
              protocol: pending.profile.protocol,
              localPath,
              remotePath: pending.profile.initial_remote_path,
              layout: preferences?.default_layout ?? "dual_pane",
              connected: true,
            });
            setConnectionDialog(null);
            setSidebarCollapsed(true);
          }}
        />
      )}
      {editorOpen && editorFile && (
        <Suspense fallback={<LoadingOverlay label={`Opening ${editorFile.name}…`} />}>
          <TextEditor file={editorFile} saving={editorSaving} onClose={() => setEditorOpen(false)} onSave={saveEditor} />
        </Suspense>
      )}
      {externalEditChange && (
        <ExternalEditDialog
          change={externalEditChange}
          saving={externalEditSaving}
          onKeepEditing={() => setExternalEditChange(null)}
          onUpload={() => void uploadExternalEdit()}
        />
      )}
      {previewLoading && (
        <LoadingOverlay
          label={previewLoading.remote ? "Downloading preview…" : "Opening preview…"}
          detail={previewLoading.name}
          onCancel={cancelPreviewLoading}
        />
      )}
      {previewFile && <ImagePreview file={previewFile} onClose={() => setPreviewFile(null)} />}
      {sudoPrompt && <SudoPasswordDialog prompt={sudoPrompt} onClose={() => { sudoPrompt.resolve(null); setSudoPrompt(null); }} onSubmit={(password) => { sudoPrompt.resolve(password); setSudoPrompt(null); }} />}
    </div>
    )}
    </>
  );
}

function Sidebar({
  profiles,
  favorites,
  bookmarkOrder,
  activeProfileId,
  activeLocalPath,
  activeRemotePath,
  connectingId,
  collapsed,
  onProfileClick,
  onEditProfile,
  onToggleFavorite,
  onOpenBookmark,
  onRemoveBookmark,
  onReorderBookmarks,
  onToggleCollapsed,
  onNew,
  onSettings,
}: {
  profiles: ConnectionProfile[];
  favorites: Favorite[];
  bookmarkOrder: Record<string, string[]>;
  activeProfileId: UUID | null;
  activeLocalPath: string | null;
  activeRemotePath: string | null;
  connectingId: UUID | null;
  collapsed: boolean;
  onProfileClick: (profile: ConnectionProfile) => void;
  onEditProfile: (profile: ConnectionProfile) => void;
  onToggleFavorite: (profile: ConnectionProfile) => void;
  onOpenBookmark: (bookmark: Favorite) => void;
  onRemoveBookmark: (bookmark: Favorite) => void;
  onReorderBookmarks: (profileId: UUID, orderedIds: string[]) => void;
  onToggleCollapsed: () => void;
  onNew: () => void;
  onSettings: () => void;
}) {
  const [profileQuery, setProfileQuery] = useState("");
  const connectionBookmarks = bookmarksForConnection(favorites, activeProfileId);
  const orderedIds = orderForProfile(bookmarkOrder, activeProfileId);
  const visibleBookmarks = orderBookmarks(connectionBookmarks, orderedIds);
  const normalizedProfileQuery = profileQuery.trim().toLowerCase();
  const visibleProfiles = profiles.filter((profile) => {
    if (!normalizedProfileQuery) return true;
    return [
      profile.label,
      profile.host,
      profile.username,
      profile.folder ?? "",
      profile.notes,
      ...profile.tags,
    ].some((value) => value.toLowerCase().includes(normalizedProfileQuery));
  });
  const profileGroups = [...new Set(visibleProfiles.map((profile) => profile.folder ?? ""))]
    .sort((left, right) => {
      if (!left) return 1;
      if (!right) return -1;
      return left.localeCompare(right);
    })
    .map((folder) => ({
      folder,
      profiles: visibleProfiles.filter((profile) => (profile.folder ?? "") === folder),
    }));

  return (
    <aside className={`sidebar ${collapsed ? "collapsed" : ""}`}>
      <div className="brand">
        <img src={appIcon} alt="" />
        <div><strong>Siftlane</strong><span>Secure file transfer</span></div>
      </div>
      <button className="primary-action" title="New connection" onClick={onNew}><Plus size={17} /><span>New Connection</span></button>
      {collapsed && (
        <CollapsedShortcuts
          favoriteProfiles={profiles.filter((profile) => profile.favorite)}
          bookmarks={visibleBookmarks}
          orderedIds={bookmarkIds(visibleBookmarks)}
          activeProfileId={activeProfileId}
          connectingId={connectingId}
          activeLocalPath={activeLocalPath ? normalizeBookmarkPath(activeLocalPath, false) : null}
          activeRemotePath={activeRemotePath ? normalizeBookmarkPath(activeRemotePath, true) : null}
          onProfileClick={onProfileClick}
          onOpenBookmark={onOpenBookmark}
          onReorderBookmarks={(nextIds) => {
            if (!activeProfileId) return;
            onReorderBookmarks(activeProfileId, nextIds);
          }}
        />
      )}
      <SidebarSection title="Connections" icon={<Server size={14} />}>
        {profiles.length > 0 && (
          <label className="profile-search">
            <Search size={13} />
            <input
              aria-label="Search profiles"
              value={profileQuery}
              onChange={(event) => setProfileQuery(event.target.value)}
              placeholder="Search profiles"
            />
            {profileQuery && (
              <button aria-label="Clear profile search" onClick={() => setProfileQuery("")}>
                <X size={12} />
              </button>
            )}
          </label>
        )}
        {profiles.length === 0 && <p className="empty-note">No saved connections</p>}
        {profiles.length > 0 && visibleProfiles.length === 0 && (
          <p className="empty-note">No matching profiles</p>
        )}
        {profileGroups.map((group) => (
          <div className="profile-folder" key={group.folder || "unfiled"}>
            <div className="profile-folder-heading">
              <Folder size={12} />
              <span>{group.folder || "Unfiled"}</span>
              <small>{group.profiles.length}</small>
            </div>
            {group.profiles.map((profile) => (
              <ConnectionItem
                key={profile.id}
                profile={profile}
                active={activeProfileId === profile.id}
                connecting={connectingId === profile.id}
                onOpen={onProfileClick}
                onEdit={onEditProfile}
                onToggleFavorite={onToggleFavorite}
              />
            ))}
          </div>
        ))}
      </SidebarSection>
      <SidebarSection title="Favorites" icon={<FolderHeart size={14} />}>
        {profiles.every((profile) => !profile.favorite) && <p className="empty-note">Star a connection to keep it here</p>}
        {profiles.filter((profile) => profile.favorite).map((profile) => <ConnectionItem key={profile.id} profile={profile} active={activeProfileId === profile.id} connecting={connectingId === profile.id} onOpen={onProfileClick} onEdit={onEditProfile} onToggleFavorite={onToggleFavorite} compact />)}
      </SidebarSection>
      <BookmarksSection
        bookmarks={visibleBookmarks}
        hasActiveConnection={!!activeProfileId}
        activeLocalPath={activeLocalPath ? normalizeBookmarkPath(activeLocalPath, false) : null}
        activeRemotePath={activeRemotePath ? normalizeBookmarkPath(activeRemotePath, true) : null}
        onOpen={onOpenBookmark}
        onRemove={onRemoveBookmark}
      />
      <SidebarSection title="Recent" icon={<FolderClock size={14} />}>
        {profiles.slice(0, 3).map((profile) => <button key={profile.id} className="nav-item" onClick={() => onProfileClick(profile)}><Clock3 size={14} /> {profile.label}</button>)}
      </SidebarSection>
      <div className="sidebar-footer">
        <button aria-label="Settings" onClick={onSettings}><Settings size={16} /></button>
        <button aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} title={collapsed ? "Expand sidebar" : "Collapse sidebar"} onClick={onToggleCollapsed}>{collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}</button>
      </div>
    </aside>
  );
}

function ConnectionItem({ profile, active, connecting, compact = false, onOpen, onEdit, onToggleFavorite }: {
  profile: ConnectionProfile;
  active: boolean;
  connecting: boolean;
  compact?: boolean;
  onOpen: (profile: ConnectionProfile) => void;
  onEdit: (profile: ConnectionProfile) => void;
  onToggleFavorite: (profile: ConnectionProfile) => void;
}) {
  return <div
    className={`connection-item ${active ? "active" : ""} ${compact ? "compact" : ""}`}
    style={{ "--profile-color": profile.color ?? "var(--teal)" } as CSSProperties}
    title={profile.notes || undefined}
  >
    <button className="connection-open" onClick={() => onOpen(profile)}>
      <span className="server-icon"><Server size={15} /></span>
      <span className="connection-copy"><strong>{profile.label}</strong>{!compact && <><small><span className="protocol-badge">{profile.protocol.toUpperCase()}</span>{profile.username}@{profile.host}</small>{profile.tags.length > 0 && <span className="profile-tag-row">{profile.tags.slice(0, 3).map((tag) => <i key={tag}>{tag}</i>)}</span>}</>}</span>
      {connecting && <LoaderCircle className="spin" size={14} />}
    </button>
    {!compact && <button className="profile-edit" aria-label={`Edit ${profile.label}`} title="Edit profile" onClick={() => onEdit(profile)}><Pencil size={13} /></button>}
    <button className="favorite-toggle" aria-label={profile.favorite ? `Remove ${profile.label} from favorites` : `Add ${profile.label} to favorites`} title={profile.favorite ? "Remove from favorites" : "Add to favorites"} onClick={() => onToggleFavorite(profile)}><Star size={14} fill={profile.favorite ? "currentColor" : "none"} /></button>
  </div>;
}

function SidebarSection({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="sidebar-section">
      <button className="section-heading" onClick={() => setOpen(!open)}>{icon}<span>{title}</span>{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button>
      {open && <div className="section-items">{children}</div>}
    </section>
  );
}

function SessionTabs({
  tabs,
  visible,
  activeId,
  actions,
  onSelect,
  onClose,
  onNew,
  onRunAction,
  onAddAction,
  onDeleteAction,
}: {
  tabs: SessionTab[];
  visible: boolean;
  activeId: UUID | null;
  actions: SavedAction[];
  onSelect: (id: UUID) => void;
  onClose: (tab: SessionTab) => void;
  onNew: () => void;
  onRunAction: (action: SavedAction) => void;
  onAddAction: () => void;
  onDeleteAction: (action: SavedAction) => void;
}) {
  return (
    <div className={`session-tabs ${visible ? "visible" : "empty"}`} aria-hidden={!visible}>
      <div className="session-tabs-list">
        {tabs.map((tab) => (
          <button key={tab.id} className={`session-tab ${activeId === tab.id ? "active" : ""}`} onClick={() => onSelect(tab.id)}>
            <i className={tab.connected ? "online" : ""} />
            <span>{tab.label}</span>
            <X size={13} onClick={(event) => { event.stopPropagation(); void onClose(tab); }} />
          </button>
        ))}
        <button className="new-tab" aria-label="New connection" onClick={onNew}><Plus size={15} /></button>
      </div>
      {visible && (
        <SessionActionsMenu
          actions={actions}
          onRun={onRunAction}
          onAdd={onAddAction}
          onDelete={onDeleteAction}
        />
      )}
    </div>
  );
}

function ConnectionHeader({
  tab,
  onSearch,
  onToggleLayout,
  onDisconnect,
}: {
  tab: SessionTab;
  onSearch: () => void;
  onToggleLayout: () => void;
  onDisconnect: () => void;
}) {
  const encrypted = tab.protocol !== "ftp";
  return (
    <header className="connection-header">
      <div className={`secure-status ${encrypted ? "" : "insecure"}`}>
        <span className="lock-circle">{encrypted ? <LockKeyhole size={13} /> : <CircleAlert size={13} />}</span>
        <strong>{tab.host}</strong>
        <small>
          <i />
          {encrypted ? (
            <>Secure · {tab.protocol.toUpperCase()}</>
          ) : (
            <>Unencrypted FTP</>
          )}
        </small>
      </div>
      <div className="header-actions">
        <button className="search-trigger" type="button" onClick={onSearch}>
          <Search size={13} />
          <span>Search</span>
          <kbd>⌘⇧F</kbd>
        </button>
        <button
          className={`layout-toggle ${tab.layout === "remote_focused" ? "is-remote" : ""}`}
          title={tab.layout === "remote_focused" ? "Show dual pane" : "Focus remote pane"}
          onClick={onToggleLayout}
        >
          <LayoutPanelLeft size={15} />
        </button>
        <button title="Connection settings"><Settings size={15} /></button>
        <button className="disconnect-action" title="Disconnect this session" onClick={onDisconnect}><LogOut size={14} /><span>Disconnect</span></button>
      </div>
    </header>
  );
}

function SudoPasswordDialog({ prompt, onClose, onSubmit }: { prompt: SudoPrompt; onClose: () => void; onSubmit: (password: string) => void }) {
  const [password, setPassword] = useState("");
  return <div className="discard-overlay" role="dialog" aria-modal="true" aria-label="Sudo authentication">
    <section className="discard-dialog sudo-dialog">
      <div className="discard-icon"><LockKeyhole size={20} /></div>
      <div><h2>Authenticate with sudo</h2><p>Enter the sudo password to edit <strong>{prompt.path}</strong>. It will not be saved.</p></div>
      <label className="sudo-password-field">Sudo password<input autoFocus type="password" value={password} onChange={(event) => setPassword(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && password) onSubmit(password); }} /></label>
      <div className="dialog-actions"><button className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={!password} onClick={() => onSubmit(password)}>Authenticate</button></div>
    </section>
  </div>;
}

function NewEntryDialog({ directory, side, privileged, onClose, onSubmit }: {
  directory: boolean;
  side: PaneSide;
  privileged: boolean;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [entryError, setEntryError] = useState<string | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setEntryError(null);
    try {
      await onSubmit(name.trim());
    } catch (reason) {
      setEntryError(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  }
  const kind = directory ? "folder" : "file";
  return <Dialog title={`New ${kind}${privileged ? " with sudo" : ""}`} subtitle={`Create in the ${side} pane`} onClose={onClose}>
    <form className="new-entry-form" onSubmit={submit}>
      <label>{directory ? "Folder name" : "File name"}<input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder={directory ? "new-folder" : "new-file.txt"} required /></label>
      {entryError && <p className="dialog-error"><CircleAlert size={14} />{entryError}</p>}
      <div className="dialog-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button type="submit" className="primary" disabled={saving || !name.trim()}>{saving && <LoaderCircle className="spin" size={15} />}{privileged ? "Create with sudo" : `Create ${kind}`}</button></div>
    </form>
  </Dialog>;
}

function ConnectionDialog({ existing, profiles, folders, onClose, onSubmit }: {
  existing: ConnectionProfile | null;
  profiles: ConnectionProfile[];
  folders: string[];
  onClose: () => void;
  onSubmit: (profile: ConnectionProfile, credential: string) => Promise<void>;
}) {
  const existingSsh = existing?.ssh_options ?? DEFAULT_SSH_OPTIONS;
  const [label, setLabel] = useState(existing?.label ?? "");
  const [protocol, setProtocol] = useState<ConnectionProfile["protocol"]>(existing?.protocol ?? "sftp");
  const [host, setHost] = useState(existing?.host ?? "");
  const [port, setPort] = useState(existing?.port ?? 22);
  const [username, setUsername] = useState(existing?.username ?? "");
  const [path, setPath] = useState(existing?.initial_remote_path ?? "/");
  const [folder, setFolder] = useState(existing?.folder ?? "");
  const [tags, setTags] = useState(existing?.tags.join(", ") ?? "");
  const [color, setColor] = useState(existing?.color ?? "#28a884");
  const [notes, setNotes] = useState(existing?.notes ?? "");
  const [authKind, setAuthKind] = useState<AuthRef["kind"]>(existing?.auth.kind ?? "password");
  const [keyPath, setKeyPath] = useState(existing?.auth.kind === "private_key" ? existing.auth.path : "");
  const [credential, setCredential] = useState("");
  const [remember, setRemember] = useState(existing?.auth.kind === "password" ? existing.auth.remember : true);
  const [showSecret, setShowSecret] = useState(false);
  const [proxyJumpProfileId, setProxyJumpProfileId] = useState(existingSsh.proxy_jump_profile_id ?? "");
  const [proxyKind, setProxyKind] = useState<"none" | "socks5" | "http_connect">(
    existingSsh.proxy?.kind ?? "none",
  );
  const [proxyHost, setProxyHost] = useState(existingSsh.proxy?.host ?? "");
  const [proxyPort, setProxyPort] = useState(existingSsh.proxy?.port ?? 1080);
  const [agentForwarding, setAgentForwarding] = useState(existingSsh.agent_forwarding === "allow");
  const [keyExchange, setKeyExchange] = useState(existingSsh.algorithms.key_exchange.join(", "));
  const [hostKeyAlgorithms, setHostKeyAlgorithms] = useState(existingSsh.algorithms.host_keys.join(", "));
  const [ciphers, setCiphers] = useState(existingSsh.algorithms.ciphers.join(", "));
  const [macs, setMacs] = useState(existingSsh.algorithms.macs.join(", "));
  const [saving, setSaving] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  async function choosePrivateKey() {
    setDialogError(null);
    try {
      const selected = await api.pickPrivateKey();
      if (selected) setKeyPath(selected);
    } catch (reason) {
      setDialogError(errorMessage(reason));
    }
  }
  const sshProtocol = protocol === "sftp";
  const protocolLabel = protocol === "ftps" ? "FTPS (explicit TLS)" : protocol.toUpperCase();
  function chooseProtocol(next: ConnectionProfile["protocol"]) {
    setProtocol(next);
    setPort(next === "sftp" ? 22 : 21);
    if (next !== "sftp" && (authKind === "private_key" || authKind === "agent")) setAuthKind("password");
    if (next === "sftp" && authKind === "anonymous") setAuthKind("password");
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setDialogError(null);
    const now = new Date().toISOString();
    const auth: AuthRef = authKind === "anonymous" ? { kind: "anonymous" } : authKind === "password" ? { kind: "password", remember } : authKind === "private_key" ? { kind: "private_key", path: keyPath, remember_passphrase: remember } : { kind: "agent" };
    const algorithmList = (value: string) =>
      value.split(",").map((item) => item.trim()).filter(Boolean);
    try {
      await onSubmit({
        id: existing?.id ?? crypto.randomUUID(),
        label,
        protocol,
        host,
        port,
        username,
        auth,
        initial_remote_path: path,
        favorite: existing?.favorite ?? false,
        ssh_options: protocol === "sftp" ? {
          proxy_jump_profile_id: proxyJumpProfileId || null,
          proxy: proxyKind === "none" ? null : { kind: proxyKind, host: proxyHost, port: proxyPort },
          agent_forwarding: agentForwarding ? "allow" : "deny",
          algorithms: {
            key_exchange: algorithmList(keyExchange),
            host_keys: algorithmList(hostKeyAlgorithms),
            ciphers: algorithmList(ciphers),
            macs: algorithmList(macs),
          },
        } : DEFAULT_SSH_OPTIONS,
        folder: folder.trim() || null,
        tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean),
        color,
        notes,
        created_at: existing?.created_at ?? now,
        updated_at: now,
      }, credential);
    } catch (reason) {
      setDialogError(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  }
  return <Dialog title={existing ? `Edit ${existing.label}` : "New connection"} subtitle={`${protocolLabel} connection details`} onClose={onClose}>
    <form className="connection-form" onSubmit={submit}>
      <fieldset><legend>Protocol</legend><div className="segmented protocol-options">{(["sftp", "ftp", "ftps"] as const).map((kind) => <button type="button" key={kind} className={protocol === kind ? "active" : ""} onClick={() => chooseProtocol(kind)}>{kind === "sftp" ? "SFTP" : kind === "ftp" ? "FTP" : "FTPS"}</button>)}</div></fieldset>
      {protocol === "ftp" && <p className="protocol-warning"><CircleAlert size={14} />FTP does not encrypt your sign-in or file transfers. Use FTPS or SFTP whenever the server supports it.</p>}
      <div className="form-grid"><label className="wide">Display name<input autoFocus value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Production server" required /></label><label className="host">Host<input value={host} onChange={(e) => setHost(e.target.value)} placeholder={sshProtocol ? "sftp.example.com" : "ftp.example.com"} required /></label><label>Port<input type="number" min={1} max={65535} value={port} onChange={(e) => setPort(Number(e.target.value))} required /></label><label>Username<input value={username} onChange={(e) => setUsername(e.target.value)} placeholder={sshProtocol ? "deploy" : "ftp-user"} required /></label><label>Initial path<input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/var/www/html" /></label></div>
      <fieldset className="profile-organization"><legend>Organization</legend><div className="form-grid"><label className="host">Folder<input list="profile-folders" value={folder} onChange={(event) => setFolder(event.target.value)} placeholder="Work / Client name" /><datalist id="profile-folders">{folders.map((value) => <option value={value} key={value} />)}</datalist></label><label className="profile-color-field">Color<span><input type="color" value={color} onChange={(event) => setColor(event.target.value)} /><code>{color.toUpperCase()}</code></span></label><label className="wide">Tags<input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="production, client, web" /></label><label className="wide">Notes<textarea value={notes} maxLength={4000} onChange={(event) => setNotes(event.target.value)} placeholder="Purpose, owner, maintenance notes…" /></label></div></fieldset>
      <fieldset><legend>Authentication</legend><div className={`segmented ${sshProtocol ? "" : "two-options"}`}>{(sshProtocol ? ["password", "private_key", "agent"] : ["password", "anonymous"]).map((kind) => <button type="button" key={kind} className={authKind === kind ? "active" : ""} onClick={() => setAuthKind(kind as AuthRef["kind"])}>{kind === "password" ? "Password" : kind === "private_key" ? "Private key" : kind === "agent" ? "SSH agent" : "Anonymous"}</button>)}</div>
        {authKind === "private_key" && <label>Private key file<span className="file-picker-field"><input value={keyPath} onChange={(e) => setKeyPath(e.target.value)} placeholder="Choose an SSH private key" required /><button type="button" className="secondary" onClick={() => void choosePrivateKey()}><FileKey2 size={15} /> Browse…</button></span></label>}
        {(authKind === "password" || authKind === "private_key") && <><label>{authKind === "password" ? "Password" : "Passphrase (if required)"}<span className="secret-field"><input type={showSecret ? "text" : "password"} value={credential} onChange={(e) => setCredential(e.target.value)} required={authKind === "password" && !existing} /><button type="button" aria-label={showSecret ? "Hide secret" : "Show secret"} onClick={() => setShowSecret(!showSecret)}>{showSecret ? <EyeOff size={15} /> : <Eye size={15} />}</button></span></label><label className="checkbox"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Store securely in the OS keyring</label></>}
        {authKind === "anonymous" && <div className="agent-note"><KeyRound size={17} /><span>Siftlane will sign in with the standard anonymous FTP account. No password is stored.</span></div>}
        {authKind === "agent" && <div className="agent-note"><KeyRound size={17} /><span>Siftlane will try identities from your running SSH agent. Private keys never enter the app.</span></div>}
      </fieldset>
      {sshProtocol && <fieldset className="enterprise-ssh"><legend>Enterprise SSH</legend>
        <div className="form-grid">
          <label className="wide">ProxyJump / bastion<select value={proxyJumpProfileId} onChange={(event) => setProxyJumpProfileId(event.target.value)}><option value="">Direct connection</option>{profiles.filter((profile) => profile.protocol === "sftp" && profile.id !== existing?.id).map((profile) => <option key={profile.id} value={profile.id}>{profile.label} · {profile.username}@{profile.host}:{profile.port}</option>)}</select></label>
          <label>Network proxy<select value={proxyKind} onChange={(event) => { const next = event.target.value as typeof proxyKind; setProxyKind(next); if (proxyPort === 1080 || proxyPort === 8080) setProxyPort(next === "socks5" ? 1080 : 8080); }}><option value="none">No proxy</option><option value="socks5">SOCKS5</option><option value="http_connect">HTTP CONNECT</option></select></label>
          {proxyKind !== "none" && <><label className="host">Proxy host<input value={proxyHost} onChange={(event) => setProxyHost(event.target.value)} placeholder="proxy.corp.example" required /></label><label>Proxy port<input type="number" min={1} max={65535} value={proxyPort} onChange={(event) => setProxyPort(Number(event.target.value))} required /></label></>}
        </div>
        <label className="checkbox enterprise-forwarding"><input type="checkbox" checked={agentForwarding} onChange={(event) => setAgentForwarding(event.target.checked)} /> Allow SSH agent forwarding for remote commands</label>
        <p className="enterprise-note">Agent forwarding is denied by default. When enabled, forwarded channels are connected only to your running local SSH agent.</p>
        <details className="ssh-algorithms">
          <summary>Custom SSH algorithm policy</summary>
          <p>Leave a list empty to use Siftlane’s safe defaults. Comma-separated values are applied in preference order.</p>
          <div className="form-grid">
            <label className="wide">Key exchange<input value={keyExchange} onChange={(event) => setKeyExchange(event.target.value)} placeholder="curve25519-sha256" /></label>
            <label className="wide">Host keys<input value={hostKeyAlgorithms} onChange={(event) => setHostKeyAlgorithms(event.target.value)} placeholder="ssh-ed25519, rsa-sha2-512" /></label>
            <label className="wide">Ciphers<input value={ciphers} onChange={(event) => setCiphers(event.target.value)} placeholder="chacha20-poly1305@openssh.com, aes256-gcm@openssh.com" /></label>
            <label className="wide">MACs<input value={macs} onChange={(event) => setMacs(event.target.value)} placeholder="hmac-sha2-512-etm@openssh.com" /></label>
          </div>
        </details>
        {proxyJumpProfileId && <p className="enterprise-route"><ShieldAlert size={14} />Traffic routes to the selected bastion first, then opens a bounded direct-tcpip channel to this host. A configured network proxy is used to reach the bastion.</p>}
      </fieldset>}
      {dialogError && <p className="dialog-error"><CircleAlert size={14} />{dialogError}</p>}
      <div className="dialog-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button type="submit" className="primary" disabled={saving}>{saving && <LoaderCircle className="spin" size={15} />}Save & Connect</button></div>
    </form>
  </Dialog>;
}

function HostKeyDialog({ value, onClose, onDecision }: { value: HostKeyChallenge; onClose: () => void; onDecision: (accept: boolean) => Promise<void> }) {
  return <Dialog title={value.changed ? "Host key changed" : "Trust this server?"} subtitle={`${value.host}:${value.port}`} onClose={onClose} tone={value.changed ? "danger" : "default"}>
    <div className="trust-content"><div className={`trust-icon ${value.changed ? "danger" : ""}`}>{value.changed ? <ShieldAlert size={26} /> : <LockKeyhole size={25} />}</div><p>{value.changed ? "The server presented a different key than the one you previously trusted. Confirm the change with your administrator before continuing." : "This is the first time Siftlane has seen this server. Verify the fingerprint before storing it."}</p><dl><div><dt>Algorithm</dt><dd>{value.algorithm}</dd></div><div><dt>SHA-256 fingerprint</dt><dd>{value.fingerprint_sha256}</dd></div></dl></div>
    <div className="dialog-actions"><button className="secondary" onClick={() => void onDecision(false)}>Cancel</button><button className={value.changed ? "danger-button" : "primary"} onClick={() => void onDecision(true)}>{value.changed ? "Replace trusted key" : "Trust & Connect"}</button></div>
  </Dialog>;
}

function Dialog({ title, subtitle, children, onClose, tone = "default" }: { title: string; subtitle: string; children: ReactNode; onClose: () => void; tone?: "default" | "danger" }) {
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className={`dialog ${tone}`} role="dialog" aria-modal="true" aria-labelledby="dialog-title"><header><div><h2 id="dialog-title">{title}</h2><p>{subtitle}</p></div><button aria-label="Close dialog" onClick={onClose}><X size={17} /></button></header>{children}</section></div>;
}

function Welcome({ profiles, onConnect, onNew }: { profiles: ConnectionProfile[]; onConnect: (profile: ConnectionProfile) => void; onNew: () => void }) {
  return <section className="welcome"><img src={appIcon} alt="" /><h1>Move files without the noise.</h1><p>Connect with SFTP, FTP, or explicit FTPS. Profiles stay local and passwords can remain in your operating system’s keyring.</p><button className="primary" onClick={onNew}><Plus size={16} /> New connection</button>{profiles.length > 0 && <div className="welcome-recents"><span>Or reconnect</span>{profiles.slice(0, 3).map((profile) => <button key={profile.id} onClick={() => onConnect(profile)}><Server size={16} /><span><strong>{profile.label}</strong><small>{profile.host}</small></span><ChevronRight size={15} /></button>)}</div>}</section>;
}

function errorMessage(reason: unknown) {
  if (typeof reason === "object" && reason && "message" in reason) {
    const detail = "detail" in reason && reason.detail ? `: ${String(reason.detail)}` : "";
    return `${String(reason.message)}${detail}`;
  }
  return String(reason);
}

function orderProfiles(profiles: ConnectionProfile[]) {
  return [...profiles].sort(
    (left, right) => Number(right.favorite) - Number(left.favorite) || left.label.localeCompare(right.label),
  );
}

function applyTheme(theme: Preferences["theme"]) {
  document.documentElement.dataset.theme = theme;
}
