import { create } from "zustand";
import type { SessionTab, TransferJob, TransferProgress, UUID } from "./types";

const SESSION_STORAGE_KEY = "siftlane.session.v1";

function loadSession() {
  try {
    const value = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!value) return { tabs: [], activeTabId: null };
    const parsed = JSON.parse(value) as { tabs?: SessionTab[]; activeTabId?: UUID | null };
    return {
      tabs: (parsed.tabs ?? []).map((tab) => ({ ...tab, connected: false })),
      activeTabId: parsed.activeTabId ?? null,
    };
  } catch {
    return { tabs: [], activeTabId: null };
  }
}

function persistSession(tabs: SessionTab[], activeTabId: UUID | null) {
  localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ tabs, activeTabId }));
}

interface AppStore {
  tabs: SessionTab[];
  activeTabId: UUID | null;
  transfers: TransferJob[];
  transferCompletionVersion: number;
  transferPanelOpen: boolean;
  expandTransfersOnNew: boolean;
  addTab: (tab: SessionTab) => void;
  closeTab: (id: UUID) => void;
  setActiveTab: (id: UUID) => void;
  updateTab: (id: UUID, patch: Partial<SessionTab>) => void;
  setTransfers: (transfers: TransferJob[], options?: { expandOnNew?: boolean }) => void;
  updateTransfer: (progress: TransferProgress) => void;
  toggleTransfers: () => void;
  setExpandTransfersOnNew: (value: boolean) => void;
}

function hasNewTransfer(previous: TransferJob[], next: TransferJob[]) {
  const existingIds = new Set(previous.map((job) => job.id));
  return next.some((job) => !existingIds.has(job.id));
}

const restored = loadSession();

export const useAppStore = create<AppStore>((set) => ({
  tabs: restored.tabs,
  activeTabId: restored.tabs.some((tab) => tab.id === restored.activeTabId)
    ? restored.activeTabId
    : (restored.tabs.at(-1)?.id ?? null),
  transfers: [],
  transferCompletionVersion: 0,
  transferPanelOpen: true,
  expandTransfersOnNew: true,
  addTab: (tab) =>
    set((state) => {
      const tabs = [...state.tabs.filter((item) => item.id !== tab.id), tab];
      persistSession(tabs, tab.id);
      return {
        tabs,
        activeTabId: tab.id,
        ...(state.transfers.length === 0 ? { transferPanelOpen: false } : {}),
      };
    }),
  closeTab: (id) =>
    set((state) => {
      const tabs = state.tabs.filter((tab) => tab.id !== id);
      const activeTabId =
        state.activeTabId === id ? (tabs.at(-1)?.id ?? null) : state.activeTabId;
      persistSession(tabs, activeTabId);
      return {
        tabs,
        activeTabId,
      };
    }),
  setActiveTab: (id) =>
    set((state) => {
      persistSession(state.tabs, id);
      return { activeTabId: id };
    }),
  updateTab: (id, patch) =>
    set((state) => {
      const tabs = state.tabs.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab));
      persistSession(tabs, state.activeTabId);
      return { tabs };
    }),
  setTransfers: (transfers, options) =>
    set((state) => {
      const previousById = new Map(state.transfers.map((job) => [job.id, job.state]));
      const completed = transfers.some(
        (job) => job.state === "completed" && previousById.get(job.id) !== "completed",
      );
      const shouldExpand =
        options?.expandOnNew !== false &&
        state.expandTransfersOnNew &&
        !state.transferPanelOpen &&
        hasNewTransfer(state.transfers, transfers);
      return {
        transfers,
        ...(completed ? { transferCompletionVersion: state.transferCompletionVersion + 1 } : {}),
        ...(shouldExpand ? { transferPanelOpen: true } : {}),
      };
    }),
  updateTransfer: (progress) =>
    set((state) => {
      const previous = state.transfers.find((job) => job.id === progress.id);
      const completed = progress.state === "completed" && previous?.state !== "completed";
      return {
        transfers: state.transfers.map((job) =>
          job.id === progress.id ? { ...job, ...progress, updated_at: new Date().toISOString() } : job,
        ),
        ...(completed ? { transferCompletionVersion: state.transferCompletionVersion + 1 } : {}),
      };
    }),
  toggleTransfers: () => set((state) => ({ transferPanelOpen: !state.transferPanelOpen })),
  setExpandTransfersOnNew: (value) => set({ expandTransfersOnNew: value }),
}));
