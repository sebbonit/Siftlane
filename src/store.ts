import { create } from "zustand";
import type { SessionTab, TransferJob, TransferProgress, UUID } from "./types";

interface AppStore {
  tabs: SessionTab[];
  activeTabId: UUID | null;
  transfers: TransferJob[];
  transferPanelOpen: boolean;
  addTab: (tab: SessionTab) => void;
  closeTab: (id: UUID) => void;
  setActiveTab: (id: UUID) => void;
  updateTab: (id: UUID, patch: Partial<SessionTab>) => void;
  setTransfers: (transfers: TransferJob[]) => void;
  updateTransfer: (progress: TransferProgress) => void;
  toggleTransfers: () => void;
}

export const useAppStore = create<AppStore>((set) => ({
  tabs: [],
  activeTabId: null,
  transfers: [],
  transferPanelOpen: true,
  addTab: (tab) =>
    set((state) => ({
      tabs: [...state.tabs.filter((item) => item.profileId !== tab.profileId), tab],
      activeTabId: tab.id,
    })),
  closeTab: (id) =>
    set((state) => {
      const tabs = state.tabs.filter((tab) => tab.id !== id);
      return {
        tabs,
        activeTabId: state.activeTabId === id ? (tabs.at(-1)?.id ?? null) : state.activeTabId,
      };
    }),
  setActiveTab: (id) => set({ activeTabId: id }),
  updateTab: (id, patch) =>
    set((state) => ({
      tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab)),
    })),
  setTransfers: (transfers) => set({ transfers }),
  updateTransfer: (progress) =>
    set((state) => ({
      transfers: state.transfers.map((job) =>
        job.id === progress.id ? { ...job, ...progress, updated_at: new Date().toISOString() } : job,
      ),
    })),
  toggleTransfers: () => set((state) => ({ transferPanelOpen: !state.transferPanelOpen })),
}));
