import { LoaderCircle, RefreshCw } from "lucide-react";
import appIcon from "../../../src-tauri/icons/128x128.png";
import { useAppVersion } from "../../hooks/useAppVersion";
import { desktop } from "../../lib/ipc";
import type { Preferences } from "../../types";
import { UpdateDialog, useManualUpdater } from "../Updater";
import type { SettingsCategoryId } from "./categories";
import { SettingsList, SettingsRow } from "./SettingsRow";

export function SettingsPanel({
  category,
  draft,
  onChange,
}: {
  category: SettingsCategoryId;
  draft: Preferences;
  onChange: (next: Preferences) => void;
}) {
  if (category === "general") {
    return <GeneralPanel draft={draft} onChange={onChange} />;
  }
  if (category === "transfers") {
    return <TransfersPanel draft={draft} onChange={onChange} />;
  }
  if (category === "connection") {
    return <ConnectionPanel draft={draft} onChange={onChange} />;
  }
  return <AboutPanel />;
}

function GeneralPanel({
  draft,
  onChange,
}: {
  draft: Preferences;
  onChange: (next: Preferences) => void;
}) {
  return (
    <SettingsList title="General">
      <SettingsRow
        label="Appearance"
        description="Choose a light, dark, or accent color scheme for the app."
        htmlFor="settings-theme"
      >
        <select
          id="settings-theme"
          value={draft.theme}
          onChange={(event) =>
            onChange({ ...draft, theme: event.target.value as Preferences["theme"] })
          }
        >
          <option value="system">Use system setting</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
          <option value="midnight">Midnight</option>
          <option value="ocean">Ocean</option>
          <option value="graphite">Graphite</option>
        </select>
      </SettingsRow>
      <SettingsRow
        label="Default layout"
        description="Layout used when opening a new connection session."
        htmlFor="settings-layout"
      >
        <select
          id="settings-layout"
          value={draft.default_layout}
          onChange={(event) =>
            onChange({
              ...draft,
              default_layout: event.target.value as Preferences["default_layout"],
            })
          }
        >
          <option value="dual_pane">Dual pane</option>
          <option value="remote_focused">Remote focused</option>
        </select>
      </SettingsRow>
      <SettingsRow
        label="Show hidden files"
        description="Include dotfiles and other hidden entries in file panes."
        htmlFor="settings-hidden"
      >
        <span className="settings-toggle">
          <input
            id="settings-hidden"
            type="checkbox"
            checked={draft.show_hidden_files}
            onChange={(event) =>
              onChange({ ...draft, show_hidden_files: event.target.checked })
            }
          />
          <span />
        </span>
      </SettingsRow>
    </SettingsList>
  );
}

function TransfersPanel({
  draft,
  onChange,
}: {
  draft: Preferences;
  onChange: (next: Preferences) => void;
}) {
  return (
    <SettingsList title="Transfers">
      <SettingsRow
        label="Global parallel transfers"
        description="Maximum number of transfers running at the same time."
        htmlFor="settings-global-parallel"
      >
        <input
          id="settings-global-parallel"
          type="number"
          min={1}
          max={12}
          value={draft.global_parallel_transfers}
          onChange={(event) =>
            onChange({
              ...draft,
              global_parallel_transfers: Number(event.target.value),
            })
          }
        />
      </SettingsRow>
      <SettingsRow
        label="Per-host parallel transfers"
        description="Limit concurrent transfers to a single remote host."
        htmlFor="settings-host-parallel"
      >
        <input
          id="settings-host-parallel"
          type="number"
          min={1}
          max={12}
          value={draft.per_host_parallel_transfers}
          onChange={(event) =>
            onChange({
              ...draft,
              per_host_parallel_transfers: Number(event.target.value),
            })
          }
        />
      </SettingsRow>
    </SettingsList>
  );
}

function ConnectionPanel({
  draft,
  onChange,
}: {
  draft: Preferences;
  onChange: (next: Preferences) => void;
}) {
  return (
    <SettingsList title="Connection">
      <SettingsRow
        label="Connect timeout"
        description="Seconds to wait while establishing a remote connection."
        htmlFor="settings-connect-timeout"
      >
        <input
          id="settings-connect-timeout"
          type="number"
          min={1}
          max={300}
          value={draft.connect_timeout_seconds}
          onChange={(event) =>
            onChange({
              ...draft,
              connect_timeout_seconds: Number(event.target.value),
            })
          }
        />
      </SettingsRow>
      <SettingsRow
        label="Response timeout"
        description="Seconds to wait for a response from the remote server."
        htmlFor="settings-response-timeout"
      >
        <input
          id="settings-response-timeout"
          type="number"
          min={1}
          max={600}
          value={draft.response_timeout_seconds}
          onChange={(event) =>
            onChange({
              ...draft,
              response_timeout_seconds: Number(event.target.value),
            })
          }
        />
      </SettingsRow>
      <SettingsRow
        label="Keepalive interval"
        description="Seconds between keepalive messages. Use 0 to disable."
        htmlFor="settings-keepalive"
      >
        <input
          id="settings-keepalive"
          type="number"
          min={0}
          max={600}
          value={draft.keepalive_seconds}
          onChange={(event) =>
            onChange({
              ...draft,
              keepalive_seconds: Number(event.target.value),
            })
          }
        />
      </SettingsRow>
    </SettingsList>
  );
}

function AboutPanel() {
  const version = useAppVersion();
  const updater = useManualUpdater();
  const checking = updater.phase === "checking";

  return (
    <div className="settings-about">
      <img src={appIcon} alt="" width={72} height={72} />
      <h3>Siftlane</h3>
      <p>Version {version}</p>
      <p className="settings-about-copy">
        A lightweight open-source file transfer client for SFTP, FTP, and explicit FTPS.
      </p>
      {desktop && (
        <button
          type="button"
          className="secondary"
          disabled={checking}
          onClick={() => void updater.checkForUpdates(true)}
        >
          {checking ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}
          {checking ? "Checking…" : "Check for updates"}
        </button>
      )}
      <UpdateDialog updater={updater} />
    </div>
  );
}
