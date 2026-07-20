import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUpFromLine,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock3,
  Eye,
  EyeOff,
  File,
  FileCode2,
  FileKey2,
  FilePlus2,
  Folder,
  FolderClock,
  FolderHeart,
  FolderPlus,
  KeyRound,
  LayoutPanelLeft,
  ListFilter,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Server,
  Settings,
  ShieldAlert,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { api, desktop } from "./lib/ipc";
import { useAppStore } from "./store";
import type {
  AppError,
  AuthRef,
  ConnectionProfile,
  FileEntry,
  HostKeyChallenge,
  Preferences,
  SessionTab,
  TransferJob,
  UUID,
} from "./types";
import appIcon from "../src-tauri/icons/128x128.png";

type PaneSide = "local" | "remote";
type EntryCreation = { side: PaneSide; directory: boolean };

export default function App() {
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [localEntries, setLocalEntries] = useState<FileEntry[]>([]);
  const [remoteEntries, setRemoteEntries] = useState<FileEntry[]>([]);
  const [selectedLocal, setSelectedLocal] = useState<FileEntry | null>(null);
  const [selectedRemote, setSelectedRemote] = useState<FileEntry | null>(null);
  const [connectionDialog, setConnectionDialog] = useState<ConnectionProfile | "new" | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [hostTrust, setHostTrust] = useState<{
    profile: ConnectionProfile;
    credential?: string;
    challenge: HostKeyChallenge;
  } | null>(null);
  const [loadingPane, setLoadingPane] = useState<PaneSide | null>(null);
  const [connectingId, setConnectingId] = useState<UUID | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [entryCreation, setEntryCreation] = useState<EntryCreation | null>(null);
  const [paneHidden, setPaneHidden] = useState<Record<PaneSide, boolean | null>>({
    local: null,
    remote: null,
  });
  const initialized = useRef(false);
  const observedCompletedTransfers = useRef<Set<UUID>>(new Set());

  const {
    tabs,
    activeTabId,
    transfers,
    addTab,
    closeTab,
    setActiveTab,
    updateTab,
    setTransfers,
    updateTransfer,
  } = useAppStore();
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const activeProfile = profiles.find((profile) => profile.id === activeTab?.profileId) ?? null;

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    void Promise.all([api.listProfiles(), api.listTransfers(), api.getPreferences()])
      .then(async ([nextProfiles, nextTransfers, nextPreferences]) => {
        setProfiles(nextProfiles);
        setTransfers(nextTransfers);
        setPreferences(nextPreferences);
        applyTheme(nextPreferences.theme);
        if (!desktop && nextProfiles[0]) await connect(nextProfiles[0]);
      })
      .catch((reason) => setError(errorMessage(reason)));
    let stop: (() => void) | undefined;
    void api.onTransferProgress(updateTransfer).then((unlisten) => {
      stop = unlisten;
    });
    return () => stop?.();
  }, [setTransfers, updateTransfer]);

  useEffect(() => {
    if (!activeTab) {
      setLocalEntries([]);
      setRemoteEntries([]);
      return;
    }
    void loadPane("local", activeTab.localPath);
    void loadPane("remote", activeTab.remotePath);
  }, [activeTab?.id]);

  useEffect(() => {
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
  }, [transfers, activeTab?.id, activeTab?.localPath, activeTab?.remotePath]);

  async function connect(profile: ConnectionProfile, credential?: string) {
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
      const localPath = await api.defaultLocalPath();
      const tab: SessionTab = {
        id: result.session_id,
        profileId: profile.id,
        label: profile.label,
        host: profile.host,
        localPath,
        remotePath: profile.initial_remote_path,
        layout: preferences?.default_layout ?? "dual_pane",
        connected: true,
      };
      addTab(tab);
      setConnectionDialog(null);
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

  async function loadPane(side: PaneSide, path: string) {
    if (!activeTab) return;
    setLoadingPane(side);
    setError(null);
    try {
      const entries =
        side === "local"
          ? await api.listLocal(path)
          : await api.listRemote(activeTab.id, path);
      if (side === "local") {
        setLocalEntries(entries);
        setSelectedLocal(null);
      } else {
        setRemoteEntries(entries);
        setSelectedRemote(null);
      }
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setLoadingPane(null);
    }
  }

  async function navigate(side: PaneSide, path: string) {
    if (!activeTab) return;
    updateTab(activeTab.id, side === "local" ? { localPath: path } : { remotePath: path });
    await loadPane(side, path);
  }

  async function addTransfer(direction: "upload" | "download") {
    if (!activeTab || !activeProfile) return;
    const selected = direction === "upload" ? selectedLocal : selectedRemote;
    if (!selected || selected.kind !== "file") {
      setError("Select a file to transfer. Folder queue expansion is intentionally disabled until traversal safeguards are complete.");
      return;
    }
    const destinationBase = direction === "upload" ? activeTab.remotePath : activeTab.localPath;
    const job = await api.enqueueTransfer({
      profileId: activeProfile.id,
      direction,
      sourcePath: selected.path,
      destinationPath: joinPath(destinationBase, selected.name, direction === "upload"),
      conflictPolicy: "ask",
    });
    setTransfers([job, ...transfers.filter((item) => item.id !== job.id)]);
  }

  async function createEntry(name: string) {
    if (!activeTab || !entryCreation) return;
    const { side, directory } = entryCreation;
    const parentPath = side === "local" ? activeTab.localPath : activeTab.remotePath;
    if (side === "local") {
      await api.createLocalEntry(parentPath, name, directory);
    } else {
      await api.createRemoteEntry(activeTab.id, parentPath, name, directory);
    }
    setEntryCreation(null);
    await loadPane(side, parentPath);
  }

  async function removeSelected(side: PaneSide) {
    if (!activeTab) return;
    const selected = side === "local" ? selectedLocal : selectedRemote;
    if (!selected) return;
    const directory = selected.kind === "directory";
    if (!(await api.confirmDelete(selected.name, directory))) return;
    setError(null);
    try {
      if (side === "local") {
        await api.deleteLocalEntry(selected.path, directory);
        setSelectedLocal(null);
        await loadPane("local", activeTab.localPath);
      } else {
        await api.deleteRemoteEntry(activeTab.id, selected.path, directory);
        setSelectedRemote(null);
        await loadPane("remote", activeTab.remotePath);
      }
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  async function handleProfileClick(profile: ConnectionProfile) {
    const existing = tabs.find((tab) => tab.profileId === profile.id);
    if (existing) {
      setActiveTab(existing.id);
      return;
    }
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

  async function closeSession(tab: SessionTab) {
    closeTab(tab.id);
    try {
      await api.disconnectSession(tab.id);
    } catch {
      // The UI can close an already-disconnected session without another alert.
    }
  }

  return (
    <div className="app-shell">
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
        activeProfileId={activeTab?.profileId ?? null}
        connectingId={connectingId}
        onProfileClick={handleProfileClick}
        onToggleFavorite={toggleFavorite}
        onNew={() => setConnectionDialog("new")}
        onSettings={() => setSettingsOpen(true)}
      />
      <main className="workspace">
        <SessionTabs
          tabs={tabs}
          activeId={activeTabId}
          onSelect={setActiveTab}
          onClose={closeSession}
          onNew={() => setConnectionDialog("new")}
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
              onDisconnect={() => void closeSession(activeTab)}
              onToggleLayout={() =>
                updateTab(activeTab.id, {
                  layout: activeTab.layout === "dual_pane" ? "remote_focused" : "dual_pane",
                })
              }
            />
            <section className={`browser-grid ${activeTab.layout === "remote_focused" ? "remote-only" : ""}`}>
              {activeTab.layout === "dual_pane" && (
                <FilePane
                  title="Local"
                  side="local"
                  path={activeTab.localPath}
                  entries={localEntries}
                  selected={selectedLocal}
                  loading={loadingPane === "local"}
                  showHidden={paneHidden.local ?? preferences?.show_hidden_files ?? true}
                  onSelect={setSelectedLocal}
                  onNavigate={(path) => navigate("local", path)}
                  onRefresh={() => loadPane("local", activeTab.localPath)}
                  onToggleHidden={() => setPaneHidden((value) => ({ ...value, local: !(value.local ?? preferences?.show_hidden_files ?? true) }))}
                  onCreateFile={() => setEntryCreation({ side: "local", directory: false })}
                  onCreateDirectory={() => setEntryCreation({ side: "local", directory: true })}
                  onRemove={() => void removeSelected("local")}
                />
              )}
              {activeTab.layout === "dual_pane" && (
                <div className="transfer-controls" aria-label="Transfer selected file">
                  <button title="Upload selected file" onClick={() => void addTransfer("upload")} disabled={!selectedLocal}>
                    <ArrowRight size={17} />
                  </button>
                  <button title="Download selected file" onClick={() => void addTransfer("download")} disabled={!selectedRemote}>
                    <ArrowLeft size={17} />
                  </button>
                </div>
              )}
              <FilePane
                title="Remote"
                subtitle={activeProfile?.host}
                side="remote"
                path={activeTab.remotePath}
                entries={remoteEntries}
                selected={selectedRemote}
                loading={loadingPane === "remote"}
                showHidden={paneHidden.remote ?? preferences?.show_hidden_files ?? true}
                onSelect={setSelectedRemote}
                onNavigate={(path) => navigate("remote", path)}
                onRefresh={() => loadPane("remote", activeTab.remotePath)}
                onToggleHidden={() => setPaneHidden((value) => ({ ...value, remote: !(value.remote ?? preferences?.show_hidden_files ?? true) }))}
                onCreateFile={() => setEntryCreation({ side: "remote", directory: false })}
                onCreateDirectory={() => setEntryCreation({ side: "remote", directory: true })}
                onRemove={() => void removeSelected("remote")}
              />
            </section>
            <TransferPanel />
          </>
        ) : (
          <Welcome profiles={profiles} onConnect={handleProfileClick} onNew={() => setConnectionDialog("new")} />
        )}
      </main>
      {entryCreation && (
        <NewEntryDialog
          directory={entryCreation.directory}
          side={entryCreation.side}
          onClose={() => setEntryCreation(null)}
          onSubmit={createEntry}
        />
      )}
      {connectionDialog && (
        <ConnectionDialog
          existing={connectionDialog === "new" ? null : connectionDialog}
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
            await api.trustHostKey(hostTrust.challenge.challenge_id, accept);
            const pending = hostTrust;
            setHostTrust(null);
            if (accept) await connect(pending.profile, pending.credential);
          }}
        />
      )}
      {settingsOpen && preferences && (
        <SettingsDialog
          value={preferences}
          onClose={() => setSettingsOpen(false)}
          onSave={async (next) => {
            await api.savePreferences(next);
            setPreferences(next);
            applyTheme(next.theme);
            setSettingsOpen(false);
          }}
        />
      )}
    </div>
  );
}

function Sidebar({
  profiles,
  activeProfileId,
  connectingId,
  onProfileClick,
  onToggleFavorite,
  onNew,
  onSettings,
}: {
  profiles: ConnectionProfile[];
  activeProfileId: UUID | null;
  connectingId: UUID | null;
  onProfileClick: (profile: ConnectionProfile) => void;
  onToggleFavorite: (profile: ConnectionProfile) => void;
  onNew: () => void;
  onSettings: () => void;
}) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <img src={appIcon} alt="" />
        <div><strong>Siftlane</strong><span>Secure file transfer</span></div>
      </div>
      <button className="primary-action" onClick={onNew}><Plus size={17} /> New Connection</button>
      <SidebarSection title="Connections" icon={<Server size={14} />}>
        {profiles.length === 0 && <p className="empty-note">No saved connections</p>}
        {profiles.map((profile) => <ConnectionItem key={profile.id} profile={profile} active={activeProfileId === profile.id} connecting={connectingId === profile.id} onOpen={onProfileClick} onToggleFavorite={onToggleFavorite} />)}
      </SidebarSection>
      <SidebarSection title="Favorites" icon={<FolderHeart size={14} />}>
        {profiles.every((profile) => !profile.favorite) && <p className="empty-note">Star a connection to keep it here</p>}
        {profiles.filter((profile) => profile.favorite).map((profile) => <ConnectionItem key={profile.id} profile={profile} active={activeProfileId === profile.id} connecting={connectingId === profile.id} onOpen={onProfileClick} onToggleFavorite={onToggleFavorite} compact />)}
      </SidebarSection>
      <SidebarSection title="Recent" icon={<FolderClock size={14} />}>
        {profiles.slice(0, 3).map((profile) => <button key={profile.id} className="nav-item" onClick={() => onProfileClick(profile)}><Clock3 size={14} /> {profile.label}</button>)}
      </SidebarSection>
      <div className="sidebar-footer">
        <button aria-label="Settings" onClick={onSettings}><Settings size={16} /></button>
        <span><i /> Local only</span>
        <button aria-label="More options"><MoreHorizontal size={17} /></button>
      </div>
    </aside>
  );
}

function ConnectionItem({ profile, active, connecting, compact = false, onOpen, onToggleFavorite }: {
  profile: ConnectionProfile;
  active: boolean;
  connecting: boolean;
  compact?: boolean;
  onOpen: (profile: ConnectionProfile) => void;
  onToggleFavorite: (profile: ConnectionProfile) => void;
}) {
  return <div className={`connection-item ${active ? "active" : ""} ${compact ? "compact" : ""}`}>
    <button className="connection-open" onClick={() => onOpen(profile)}>
      <span className="server-icon"><Server size={15} /></span>
      <span className="connection-copy"><strong>{profile.label}</strong>{!compact && <small>{profile.username}@{profile.host}</small>}</span>
      {connecting && <LoaderCircle className="spin" size={14} />}
    </button>
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

function SessionTabs({ tabs, activeId, onSelect, onClose, onNew }: {
  tabs: SessionTab[];
  activeId: UUID | null;
  onSelect: (id: UUID) => void;
  onClose: (tab: SessionTab) => void;
  onNew: () => void;
}) {
  return (
    <div className="session-tabs">
      {tabs.map((tab) => (
        <button key={tab.id} className={`session-tab ${activeId === tab.id ? "active" : ""}`} onClick={() => onSelect(tab.id)}>
          <i className={tab.connected ? "online" : ""} />
          <span>{tab.label}</span>
          <X size={13} onClick={(event) => { event.stopPropagation(); void onClose(tab); }} />
        </button>
      ))}
      <button className="new-tab" aria-label="New connection" onClick={onNew}><Plus size={15} /></button>
    </div>
  );
}

function ConnectionHeader({ tab, onToggleLayout, onDisconnect }: { tab: SessionTab; onToggleLayout: () => void; onDisconnect: () => void }) {
  return (
    <header className="connection-header">
      <div className="secure-status"><span className="lock-circle"><LockKeyhole size={16} /></span><div><strong>{tab.host}</strong><small><i /> Connected securely</small></div></div>
      <div className="header-actions">
        <button className="search-trigger"><Search size={15} /><span>Search</span><kbd>⌘F</kbd></button>
        <button title="Toggle layout" onClick={onToggleLayout}><LayoutPanelLeft size={17} /></button>
        <button title="Connection settings"><Settings size={17} /></button>
        <button className="disconnect-action" title="Disconnect this session" onClick={onDisconnect}><LogOut size={16} /><span>Disconnect</span></button>
      </div>
    </header>
  );
}

function FilePane({ title, subtitle, side, path, entries, selected, loading, showHidden, onSelect, onNavigate, onRefresh, onToggleHidden, onCreateFile, onCreateDirectory, onRemove }: {
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
  onRemove: () => void;
}) {
  const [query, setQuery] = useState("");
  const visible = useMemo(() => entries.filter((entry) => (showHidden || !entry.hidden) && entry.name.toLowerCase().includes(query.toLowerCase())), [entries, query, showHidden]);
  return (
    <section className="file-pane" aria-label={`${title} files`}>
      <div className="pane-title"><div><strong>{title}</strong>{subtitle && <span>{subtitle}</span>}</div><div className="pane-actions"><button title={showHidden ? "Hide hidden files" : "Show hidden files"} onClick={onToggleHidden}>{showHidden ? <EyeOff size={15} /> : <Eye size={15} />}</button><button title="New file" onClick={onCreateFile}><FilePlus2 size={15} /></button><button title="New folder" onClick={onCreateDirectory}><FolderPlus size={15} /></button><button title="Delete selected" onClick={onRemove} disabled={!selected}><Trash2 size={15} /></button><button title="Refresh" onClick={onRefresh}><RefreshCw className={loading ? "spin" : ""} size={15} /></button></div></div>
      <div className="path-toolbar">
        <button title="Parent folder" onClick={() => onNavigate(parentPath(path, side === "remote"))}><ArrowLeft size={15} /></button>
        <div className="path-field"><Folder size={15} /><span>{path}</span></div>
        <label className="filter-field"><Search size={14} /><input aria-label={`Filter ${title} files`} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter" /></label>
      </div>
      <div className="file-table" role="table">
        <div className="file-header" role="row"><span>Name</span><span>Size</span><span>Modified</span><span aria-label="Permissions">Mode</span></div>
        <div className="file-rows">
          {loading && entries.length === 0 ? <div className="pane-message"><LoaderCircle className="spin" size={20} /> Loading directory…</div> : visible.map((entry) => (
            <button
              key={entry.path}
              className={`file-row ${selected?.path === entry.path ? "selected" : ""}`}
              onClick={() => onSelect(entry)}
              onDoubleClick={() => entry.kind === "directory" && onNavigate(entry.path)}
              role="row"
            >
              <span className="file-name">{fileIcon(entry)}<span>{entry.name}</span>{entry.kind === "symlink" && <small>→ {entry.symlink_target}</small>}</span>
              <span>{entry.kind === "directory" ? "—" : formatBytes(entry.size)}</span>
              <span>{formatDate(entry.modified_at)}</span>
              <span className="permissions">{formatPermissions(entry.permissions)}</span>
            </button>
          ))}
          {!loading && visible.length === 0 && <div className="pane-message">No matching files</div>}
        </div>
      </div>
      <footer className="pane-footer"><span>{visible.length} items</span><span>{formatBytes(visible.reduce((sum, item) => sum + (item.size ?? 0), 0))}</span></footer>
    </section>
  );
}

function TransferPanel() {
  const { transfers, transferPanelOpen, toggleTransfers, setTransfers } = useAppStore();
  const [filter, setFilter] = useState<"active" | "completed" | "failed">("active");
  const filtered = transfers.filter((job) => filter === "active" ? !["completed", "failed", "cancelled"].includes(job.state) : filter === "completed" ? job.state === "completed" : ["failed", "cancelled"].includes(job.state));
  async function act(job: TransferJob, action: "pause" | "resume" | "cancel" | "retry") {
    const updated = await api.controlTransfer(job.id, action);
    setTransfers(transfers.map((item) => item.id === job.id ? updated : item));
  }
  return (
    <section className={`transfer-panel ${transferPanelOpen ? "open" : "closed"}`}>
      <header className="transfer-heading">
        <button className="transfer-title" onClick={toggleTransfers}>{transferPanelOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}<strong>Transfers</strong><span>{transfers.filter((job) => job.state === "running").length}</span></button>
        <nav aria-label="Transfer filters">
          {(["active", "completed", "failed"] as const).map((value) => <button key={value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>{capitalize(value)} <span>{countTransferFilter(transfers, value)}</span></button>)}
        </nav>
      </header>
      {transferPanelOpen && (
        <div className="transfer-list">
          <div className="transfer-list-header"><span>Name</span><span>Direction</span><span>Progress</span><span>Speed</span><span>Status</span><span /></div>
          {filtered.map((job) => {
            const progress = job.bytes_total ? Math.min(100, (job.bytes_transferred / job.bytes_total) * 100) : 0;
            return <div className="transfer-row" key={job.id}>
              <span className="transfer-name"><File size={15} />{job.source_path.split(/[\\/]/).pop()}</span>
              <span>{job.direction === "upload" ? <ArrowUpFromLine size={14} /> : <ArrowDownToLine size={14} />}{capitalize(job.direction)}</span>
              <span className="progress-cell"><span className="progress-track"><i style={{ width: `${progress}%` }} /></span><small>{Math.round(progress)}%</small></span>
              <span>{job.speed_bytes_per_second ? `${formatBytes(job.speed_bytes_per_second)}/s` : "—"}</span>
              <span className={`state ${job.state}`}><i />{job.error ?? capitalize(job.state.replaceAll("_", " "))}</span>
              <span className="row-actions">
                {job.state === "running" && <button title="Pause" onClick={() => void act(job, "pause")}><Pause size={14} /></button>}
                {["paused", "interrupted"].includes(job.state) && <button title="Resume" onClick={() => void act(job, "resume")}><Play size={14} /></button>}
                {job.state === "failed" && <button title="Retry" onClick={() => void act(job, "retry")}><RefreshCw size={14} /></button>}
                {!['completed', 'cancelled'].includes(job.state) && <button title="Cancel" onClick={() => void act(job, "cancel")}><X size={14} /></button>}
              </span>
            </div>;
          })}
          {filtered.length === 0 && <div className="empty-transfers">No {filter} transfers</div>}
        </div>
      )}
    </section>
  );
}

function NewEntryDialog({ directory, side, onClose, onSubmit }: {
  directory: boolean;
  side: PaneSide;
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
  return <Dialog title={`New ${kind}`} subtitle={`Create in the ${side} pane`} onClose={onClose}>
    <form className="new-entry-form" onSubmit={submit}>
      <label>{directory ? "Folder name" : "File name"}<input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder={directory ? "new-folder" : "new-file.txt"} required /></label>
      {entryError && <p className="dialog-error"><CircleAlert size={14} />{entryError}</p>}
      <div className="dialog-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button type="submit" className="primary" disabled={saving || !name.trim()}>{saving && <LoaderCircle className="spin" size={15} />}Create {kind}</button></div>
    </form>
  </Dialog>;
}

function ConnectionDialog({ existing, onClose, onSubmit }: {
  existing: ConnectionProfile | null;
  onClose: () => void;
  onSubmit: (profile: ConnectionProfile, credential: string) => Promise<void>;
}) {
  const [label, setLabel] = useState(existing?.label ?? "");
  const [host, setHost] = useState(existing?.host ?? "");
  const [port, setPort] = useState(existing?.port ?? 22);
  const [username, setUsername] = useState(existing?.username ?? "");
  const [path, setPath] = useState(existing?.initial_remote_path ?? "/");
  const [authKind, setAuthKind] = useState<AuthRef["kind"]>(existing?.auth.kind ?? "password");
  const [keyPath, setKeyPath] = useState(existing?.auth.kind === "private_key" ? existing.auth.path : "");
  const [credential, setCredential] = useState("");
  const [remember, setRemember] = useState(existing?.auth.kind === "password" ? existing.auth.remember : true);
  const [showSecret, setShowSecret] = useState(false);
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
  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setDialogError(null);
    const now = new Date().toISOString();
    const auth: AuthRef = authKind === "password" ? { kind: "password", remember } : authKind === "private_key" ? { kind: "private_key", path: keyPath, remember_passphrase: remember } : { kind: "agent" };
    try {
      await onSubmit({
        id: existing?.id ?? crypto.randomUUID(),
        label,
        protocol: "sftp",
        host,
        port,
        username,
        auth,
        initial_remote_path: path,
        favorite: existing?.favorite ?? false,
        created_at: existing?.created_at ?? now,
        updated_at: now,
      }, credential);
    } catch (reason) {
      setDialogError(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  }
  return <Dialog title={existing ? `Connect to ${existing.label}` : "New connection"} subtitle="SFTP connection details" onClose={onClose}>
    <form className="connection-form" onSubmit={submit}>
      <div className="form-grid"><label className="wide">Display name<input autoFocus value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Production server" required /></label><label className="host">Host<input value={host} onChange={(e) => setHost(e.target.value)} placeholder="sftp.example.com" required /></label><label>Port<input type="number" min={1} max={65535} value={port} onChange={(e) => setPort(Number(e.target.value))} required /></label><label>Username<input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="deploy" required /></label><label>Initial path<input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/var/www/html" /></label></div>
      <fieldset><legend>Authentication</legend><div className="segmented">{(["password", "private_key", "agent"] as const).map((kind) => <button type="button" key={kind} className={authKind === kind ? "active" : ""} onClick={() => setAuthKind(kind)}>{kind === "password" ? "Password" : kind === "private_key" ? "Private key" : "SSH agent"}</button>)}</div>
        {authKind === "private_key" && <label>Private key file<span className="file-picker-field"><input value={keyPath} onChange={(e) => setKeyPath(e.target.value)} placeholder="Choose an SSH private key" required /><button type="button" className="secondary" onClick={() => void choosePrivateKey()}><FileKey2 size={15} /> Browse…</button></span></label>}
        {authKind !== "agent" && <><label>{authKind === "password" ? "Password" : "Passphrase (if required)"}<span className="secret-field"><input type={showSecret ? "text" : "password"} value={credential} onChange={(e) => setCredential(e.target.value)} required={authKind === "password" && !existing} /><button type="button" aria-label={showSecret ? "Hide secret" : "Show secret"} onClick={() => setShowSecret(!showSecret)}>{showSecret ? <EyeOff size={15} /> : <Eye size={15} />}</button></span></label><label className="checkbox"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Store securely in the OS keyring</label></>}
        {authKind === "agent" && <div className="agent-note"><KeyRound size={17} /><span>Siftlane will try identities from your running SSH agent. Private keys never enter the app.</span></div>}
      </fieldset>
      {dialogError && <p className="dialog-error"><CircleAlert size={14} />{dialogError}</p>}
      <div className="dialog-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button type="submit" className="primary" disabled={saving}>{saving && <LoaderCircle className="spin" size={15} />}{existing ? "Connect" : "Save & Connect"}</button></div>
    </form>
  </Dialog>;
}

function HostKeyDialog({ value, onClose, onDecision }: { value: HostKeyChallenge; onClose: () => void; onDecision: (accept: boolean) => Promise<void> }) {
  return <Dialog title={value.changed ? "Host key changed" : "Trust this server?"} subtitle={`${value.host}:${value.port}`} onClose={onClose} tone={value.changed ? "danger" : "default"}>
    <div className="trust-content"><div className={`trust-icon ${value.changed ? "danger" : ""}`}>{value.changed ? <ShieldAlert size={26} /> : <LockKeyhole size={25} />}</div><p>{value.changed ? "The server presented a different key than the one you previously trusted. Confirm the change with your administrator before continuing." : "This is the first time Siftlane has seen this server. Verify the fingerprint before storing it."}</p><dl><div><dt>Algorithm</dt><dd>{value.algorithm}</dd></div><div><dt>SHA-256 fingerprint</dt><dd>{value.fingerprint_sha256}</dd></div></dl></div>
    <div className="dialog-actions"><button className="secondary" onClick={() => void onDecision(false)}>Cancel</button><button className={value.changed ? "danger-button" : "primary"} onClick={() => void onDecision(true)}>{value.changed ? "Replace trusted key" : "Trust & Connect"}</button></div>
  </Dialog>;
}

function SettingsDialog({ value, onClose, onSave }: { value: Preferences; onClose: () => void; onSave: (value: Preferences) => Promise<void> }) {
  const [draft, setDraft] = useState(value);
  return <Dialog title="Settings" subtitle="Appearance and transfer behavior" onClose={onClose}>
    <div className="settings-form"><label>Appearance<select value={draft.theme} onChange={(e) => setDraft({ ...draft, theme: e.target.value as Preferences["theme"] })}><option value="system">Use system setting</option><option value="light">Light</option><option value="dark">Dark</option></select></label><label>Default layout<select value={draft.default_layout} onChange={(e) => setDraft({ ...draft, default_layout: e.target.value as Preferences["default_layout"] })}><option value="dual_pane">Dual pane</option><option value="remote_focused">Remote focused</option></select></label><label className="checkbox"><input type="checkbox" checked={draft.show_hidden_files} onChange={(e) => setDraft({ ...draft, show_hidden_files: e.target.checked })} /> Show hidden files</label><label>Parallel transfers<input type="number" min={1} max={12} value={draft.global_parallel_transfers} onChange={(e) => setDraft({ ...draft, global_parallel_transfers: Number(e.target.value) })} /></label></div>
    <div className="dialog-actions"><button className="secondary" onClick={onClose}>Cancel</button><button className="primary" onClick={() => void onSave(draft)}>Save settings</button></div>
  </Dialog>;
}

function Dialog({ title, subtitle, children, onClose, tone = "default" }: { title: string; subtitle: string; children: ReactNode; onClose: () => void; tone?: "default" | "danger" }) {
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className={`dialog ${tone}`} role="dialog" aria-modal="true" aria-labelledby="dialog-title"><header><div><h2 id="dialog-title">{title}</h2><p>{subtitle}</p></div><button aria-label="Close dialog" onClick={onClose}><X size={17} /></button></header>{children}</section></div>;
}

function Welcome({ profiles, onConnect, onNew }: { profiles: ConnectionProfile[]; onConnect: (profile: ConnectionProfile) => void; onNew: () => void }) {
  return <section className="welcome"><img src={appIcon} alt="" /><h1>Move files without the noise.</h1><p>Connect securely over SFTP. Your profiles stay local and credentials stay in your operating system’s keyring.</p><button className="primary" onClick={onNew}><Plus size={16} /> New connection</button>{profiles.length > 0 && <div className="welcome-recents"><span>Or reconnect</span>{profiles.slice(0, 3).map((profile) => <button key={profile.id} onClick={() => onConnect(profile)}><Server size={16} /><span><strong>{profile.label}</strong><small>{profile.host}</small></span><ChevronRight size={15} /></button>)}</div>}</section>;
}

function fileIcon(entry: FileEntry) {
  if (entry.kind === "directory") return <Folder size={17} fill="currentColor" />;
  if (/\.(tsx?|jsx?|html|css|json|rs)$/i.test(entry.name)) return <FileCode2 size={16} />;
  return <File size={16} />;
}

function errorMessage(reason: unknown) {
  if (typeof reason === "object" && reason && "message" in reason) return String(reason.message);
  return String(reason);
}

function joinPath(base: string, name: string, remote: boolean) {
  const separator = remote ? "/" : base.includes("\\") ? "\\" : "/";
  return `${base.replace(/[\\/]$/, "")}${separator}${name}`;
}

function parentPath(path: string, remote: boolean) {
  const normalized = path.replace(/[\\/]+$/, "");
  const separator = remote ? "/" : normalized.includes("\\") ? "\\" : "/";
  const index = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  if (index <= 0) return remote ? "/" : normalized.slice(0, Math.max(1, index + 1));
  return normalized.slice(0, index) || separator;
}

function formatBytes(bytes: number | null) {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; value >= 1024 && index < units.length; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function formatPermissions(value: number | null) {
  return value == null ? "—" : `0${value.toString(8).padStart(3, "0")}`;
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function orderProfiles(profiles: ConnectionProfile[]) {
  return [...profiles].sort(
    (left, right) => Number(right.favorite) - Number(left.favorite) || left.label.localeCompare(right.label),
  );
}

function countTransferFilter(transfers: TransferJob[], filter: "active" | "completed" | "failed") {
  return transfers.filter((job) => filter === "active" ? !["completed", "failed", "cancelled"].includes(job.state) : filter === "completed" ? job.state === "completed" : ["failed", "cancelled"].includes(job.state)).length;
}

function applyTheme(theme: Preferences["theme"]) {
  document.documentElement.dataset.theme = theme;
}
