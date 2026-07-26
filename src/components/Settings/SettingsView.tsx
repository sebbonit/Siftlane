import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { RotateCcw } from "lucide-react";
import { desktop } from "../../lib/ipc";
import type { ConnectionProfile, Preferences } from "../../types";
import { type SettingsCategoryId } from "./categories";
import { SettingsPanel } from "./SettingsPanels";
import { SettingsSidebar } from "./SettingsSidebar";

export const DEFAULT_PREFERENCES: Preferences = {
  theme: "system",
  default_layout: "dual_pane",
  show_hidden_files: true,
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

function preferencesEqual(left: Preferences, right: Preferences) {
  return (
    left.theme === right.theme &&
    left.default_layout === right.default_layout &&
    left.show_hidden_files === right.show_hidden_files &&
    left.global_parallel_transfers === right.global_parallel_transfers &&
    left.per_host_parallel_transfers === right.per_host_parallel_transfers &&
    left.expand_transfers_on_new === right.expand_transfers_on_new &&
    left.automatic_retry_limit === right.automatic_retry_limit &&
    left.connect_timeout_seconds === right.connect_timeout_seconds &&
    left.response_timeout_seconds === right.response_timeout_seconds &&
    left.keepalive_seconds === right.keepalive_seconds
    && left.restore_sessions === right.restore_sessions
    && left.global_upload_limit_bps === right.global_upload_limit_bps
    && left.global_download_limit_bps === right.global_download_limit_bps
  );
}

export function SettingsView({
  value,
  onBack,
  onChange,
  profiles = [],
  onConfigurationImported,
}: {
  value: Preferences;
  onBack: () => void;
  onChange: (value: Preferences) => void;
  profiles?: ConnectionProfile[];
  onConfigurationImported: () => Promise<void>;
}) {
  const [category, setCategory] = useState<SettingsCategoryId>("general");
  const [draft, setDraft] = useState(value);
  const atDefaults = preferencesEqual(draft, DEFAULT_PREFERENCES);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  function commit(next: Preferences) {
    setDraft(next);
    onChange(next);
  }

  return (
    <div className="app-shell settings-shell">
      <div
        className="window-drag-region"
        data-tauri-drag-region
        onMouseDown={(event) => {
          if (desktop && event.button === 0) void getCurrentWindow().startDragging();
        }}
      >
        <span data-tauri-drag-region>Settings</span>
      </div>
      <SettingsSidebar activeId={category} onSelect={setCategory} onBack={onBack} />
      <main className="settings-workspace">
        <header className="settings-header">
          <h1>Settings</h1>
          <button
            type="button"
            className="settings-restore"
            disabled={atDefaults}
            onClick={() =>
              commit({ ...DEFAULT_PREFERENCES, bookmark_order: draft.bookmark_order })
            }
          >
            <RotateCcw size={14} />
            Restore defaults
          </button>
        </header>
        <section className="settings-content" aria-label="Settings">
          <SettingsPanel
            category={category}
            draft={draft}
            onChange={commit}
            profiles={profiles}
            onConfigurationImported={onConfigurationImported}
          />
        </section>
      </main>
    </div>
  );
}
