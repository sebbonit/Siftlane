import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { RotateCcw } from "lucide-react";
import { desktop } from "../../lib/ipc";
import type { Preferences } from "../../types";
import { type SettingsCategoryId } from "./categories";
import { SettingsPanel } from "./SettingsPanels";
import { SettingsSidebar } from "./SettingsSidebar";

export const DEFAULT_PREFERENCES: Preferences = {
  theme: "system",
  default_layout: "dual_pane",
  show_hidden_files: true,
  global_parallel_transfers: 3,
  per_host_parallel_transfers: 2,
  connect_timeout_seconds: 15,
  response_timeout_seconds: 30,
  keepalive_seconds: 30,
};

function preferencesEqual(left: Preferences, right: Preferences) {
  return (
    left.theme === right.theme &&
    left.default_layout === right.default_layout &&
    left.show_hidden_files === right.show_hidden_files &&
    left.global_parallel_transfers === right.global_parallel_transfers &&
    left.per_host_parallel_transfers === right.per_host_parallel_transfers &&
    left.connect_timeout_seconds === right.connect_timeout_seconds &&
    left.response_timeout_seconds === right.response_timeout_seconds &&
    left.keepalive_seconds === right.keepalive_seconds
  );
}

export function SettingsView({
  value,
  onBack,
  onChange,
}: {
  value: Preferences;
  onBack: () => void;
  onChange: (value: Preferences) => void;
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
            onClick={() => commit(DEFAULT_PREFERENCES)}
          >
            <RotateCcw size={14} />
            Restore defaults
          </button>
        </header>
        <section className="settings-content" aria-label="Settings">
          <SettingsPanel category={category} draft={draft} onChange={commit} />
        </section>
      </main>
    </div>
  );
}
