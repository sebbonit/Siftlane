import { useState } from "react";
import { FolderOpen, LoaderCircle, RefreshCw, Trash2 } from "lucide-react";
import appIcon from "../../../src-tauri/icons/128x128.png";
import { useAppVersion } from "../../hooks/useAppVersion";
import { api } from "../../lib/ipc";
import type { ConnectionProfile, Preferences } from "../../types";
import { UpdateDialog, updatesEnabled, useManualUpdater } from "../Updater";
import { ConfigurationPanel } from "./ConfigurationPanel";
import type { SettingsCategoryId } from "./categories";
import { SettingsList, SettingsRow } from "./SettingsRow";
import { TrustedHostsPanel } from "./TrustedHostsPanel";

export function SettingsPanel({
  category,
  draft,
  onChange,
  profiles = [],
  onConfigurationImported,
}: {
  category: SettingsCategoryId;
  draft: Preferences;
  onChange: (next: Preferences) => void;
  profiles?: ConnectionProfile[];
  onConfigurationImported: () => Promise<void>;
}) {
  if (category === "general") {
    return <GeneralPanel draft={draft} onChange={onChange} />;
  }
  if (category === "transfers") {
    return <TransfersPanel draft={draft} onChange={onChange} profiles={profiles} />;
  }
  if (category === "profiles") {
    return (
      <ConfigurationPanel profiles={profiles} onImported={onConfigurationImported} />
    );
  }
  if (category === "connection") {
    return <ConnectionPanel draft={draft} onChange={onChange} />;
  }
  if (category === "trusted_hosts") {
    return <TrustedHostsPanel />;
  }
  if (category === "diagnostics") {
    return <DiagnosticsPanel draft={draft} onChange={onChange} />;
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
        label="Restore sessions"
        description="Reconnect open tabs and restore their paths and layouts when Siftlane launches."
        htmlFor="settings-restore-sessions"
      >
        <span className="settings-toggle">
          <input
            id="settings-restore-sessions"
            type="checkbox"
            checked={draft.restore_sessions}
            onChange={(event) => onChange({ ...draft, restore_sessions: event.target.checked })}
          />
          <span />
        </span>
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
  profiles,
}: {
  draft: Preferences;
  onChange: (next: Preferences) => void;
  profiles: ConnectionProfile[];
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
        label="Global upload limit"
        description="Shared across all uploads. Set 0 for unlimited."
        htmlFor="settings-upload-limit"
      >
        <input
          id="settings-upload-limit"
          type="number"
          min={0}
          value={Math.round((draft.global_upload_limit_bps ?? 0) / 1024)}
          onChange={(event) => onChange({
            ...draft,
            global_upload_limit_bps: Number(event.target.value) > 0
              ? Number(event.target.value) * 1024
              : null,
          })}
        />
        <small>KB/s</small>
      </SettingsRow>
      <SettingsRow
        label="Global download limit"
        description="Shared across all downloads. Set 0 for unlimited."
        htmlFor="settings-download-limit"
      >
        <input
          id="settings-download-limit"
          type="number"
          min={0}
          value={Math.round((draft.global_download_limit_bps ?? 0) / 1024)}
          onChange={(event) => onChange({
            ...draft,
            global_download_limit_bps: Number(event.target.value) > 0
              ? Number(event.target.value) * 1024
              : null,
          })}
        />
        <small>KB/s</small>
      </SettingsRow>
      {profiles.map((profile) => {
        const limit = draft.profile_bandwidth_limits[profile.id] ?? {
          upload_bps: null,
          download_bps: null,
        };
        return (
          <SettingsRow
            key={profile.id}
            label={`${profile.label} bandwidth`}
            description="Per-profile upload / download limits in KB/s. Zero is unlimited."
            htmlFor={`profile-limit-${profile.id}`}
          >
            <span className="profile-bandwidth">
              <input
                id={`profile-limit-${profile.id}`}
                type="number"
                min={0}
                aria-label={`${profile.label} upload limit`}
                value={Math.round((limit.upload_bps ?? 0) / 1024)}
                onChange={(event) => onChange({
                  ...draft,
                  profile_bandwidth_limits: {
                    ...draft.profile_bandwidth_limits,
                    [profile.id]: {
                      ...limit,
                      upload_bps: Number(event.target.value) > 0
                        ? Number(event.target.value) * 1024
                        : null,
                    },
                  },
                })}
              />
              <span>/</span>
              <input
                type="number"
                min={0}
                aria-label={`${profile.label} download limit`}
                value={Math.round((limit.download_bps ?? 0) / 1024)}
                onChange={(event) => onChange({
                  ...draft,
                  profile_bandwidth_limits: {
                    ...draft.profile_bandwidth_limits,
                    [profile.id]: {
                      ...limit,
                      download_bps: Number(event.target.value) > 0
                        ? Number(event.target.value) * 1024
                        : null,
                    },
                  },
                })}
              />
            </span>
          </SettingsRow>
        );
      })}
      <SettingsRow
        label="Temporary limit"
        description="Use the current global limits for one hour, then automatically expire."
      >
        {draft.temporary_bandwidth_limit &&
        Date.parse(draft.temporary_bandwidth_limit.expires_at) > Date.now() ? (
          <button
            className="secondary"
            onClick={() => onChange({ ...draft, temporary_bandwidth_limit: null })}
          >
            Clear one-hour limit
          </button>
        ) : (
          <button
            className="secondary"
            disabled={!draft.global_upload_limit_bps && !draft.global_download_limit_bps}
            title={
              !draft.global_upload_limit_bps && !draft.global_download_limit_bps
                ? "Set a global upload or download limit first"
                : undefined
            }
            onClick={() => onChange({
              ...draft,
              temporary_bandwidth_limit: {
                upload_bps: draft.global_upload_limit_bps,
                download_bps: draft.global_download_limit_bps,
                expires_at: new Date(Date.now() + 3_600_000).toISOString(),
              },
            })}
          >
            Limit for one hour
          </button>
        )}
      </SettingsRow>
      {draft.bandwidth_schedules.map((schedule) => (
        <SettingsRow
          key={schedule.id}
          label={schedule.label}
          description="Active window (local time). Empty limits mean unlimited."
        >
          <span className="schedule-controls">
            <input
              type="checkbox"
              aria-label={`Enable ${schedule.label}`}
              checked={schedule.enabled}
              onChange={(event) => onChange({
                ...draft,
                bandwidth_schedules: draft.bandwidth_schedules.map((item) =>
                  item.id === schedule.id ? { ...item, enabled: event.target.checked } : item,
                ),
              })}
            />
            <input
              type="time"
              aria-label={`${schedule.label} start time`}
              value={schedule.start_time}
              onChange={(event) => onChange({
                ...draft,
                bandwidth_schedules: draft.bandwidth_schedules.map((item) =>
                  item.id === schedule.id ? { ...item, start_time: event.target.value } : item,
                ),
              })}
            />
            <span>to</span>
            <input
              type="time"
              aria-label={`${schedule.label} end time`}
              value={schedule.end_time}
              onChange={(event) => onChange({
                ...draft,
                bandwidth_schedules: draft.bandwidth_schedules.map((item) =>
                  item.id === schedule.id ? { ...item, end_time: event.target.value } : item,
                ),
              })}
            />
            <button
              className="secondary"
              onClick={() => onChange({
                ...draft,
                bandwidth_schedules: draft.bandwidth_schedules.filter(
                  (item) => item.id !== schedule.id,
                ),
              })}
            >
              Remove
            </button>
          </span>
        </SettingsRow>
      ))}
      <SettingsRow
        label="Schedules"
        description="Reusable time windows override global limits while active."
      >
        <button
          className="secondary"
          onClick={() => onChange({
            ...draft,
            bandwidth_schedules: [
              ...draft.bandwidth_schedules,
              {
                id: crypto.randomUUID(),
                label: "Unlimited after 18:00",
                start_time: "18:00",
                end_time: "08:00",
                upload_bps: null,
                download_bps: null,
                days: [0, 1, 2, 3, 4, 5, 6],
                enabled: true,
              },
            ],
          })}
        >
          Add “unlimited after 18:00”
        </button>
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
      <SettingsRow
        label="Expand on new transfer"
        description="Automatically open the transfers panel when a new transfer is queued."
        htmlFor="settings-expand-transfers"
      >
        <span className="settings-toggle">
          <input
            id="settings-expand-transfers"
            type="checkbox"
            checked={draft.expand_transfers_on_new}
            onChange={(event) =>
              onChange({ ...draft, expand_transfers_on_new: event.target.checked })
            }
          />
          <span />
        </span>
      </SettingsRow>
      <SettingsRow
        label="Automatic retries"
        description="Retry transient network failures before requiring attention."
        htmlFor="settings-automatic-retries"
      >
        <input
          id="settings-automatic-retries"
          type="number"
          min={0}
          max={10}
          value={draft.automatic_retry_limit}
          onChange={(event) =>
            onChange({
              ...draft,
              automatic_retry_limit: Number(event.target.value),
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

function DiagnosticsPanel({
  draft,
  onChange,
}: {
  draft: Preferences;
  onChange: (next: Preferences) => void;
}) {
  const [busy, setBusy] = useState<"reveal" | "clear" | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  async function revealLogs() {
    setBusy("reveal");
    setStatus(null);
    try {
      const path = await api.getDiagnosticsLogPath();
      await api.revealInFileManager(path);
    } catch {
      setStatus("The diagnostic log could not be shown.");
    } finally {
      setBusy(null);
    }
  }

  async function clearLogs() {
    setBusy("clear");
    setStatus(null);
    try {
      await api.clearDiagnosticLogs();
      setStatus("Saved diagnostic logs were cleared.");
    } catch {
      setStatus("The diagnostic logs could not be cleared.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <SettingsList title="Diagnostics">
      <SettingsRow
        label="Save diagnostic logs"
        description="Opt in to metadata-only troubleshooting logs. Turning this off stops new entries but keeps existing files until you clear them."
        htmlFor="settings-diagnostics-enabled"
      >
        <span className="settings-toggle">
          <input
            id="settings-diagnostics-enabled"
            type="checkbox"
            checked={draft.diagnostics_enabled}
            onChange={(event) =>
              onChange({ ...draft, diagnostics_enabled: event.target.checked })
            }
          />
          <span />
        </span>
      </SettingsRow>
      <SettingsRow
        label="What is recorded"
        description="App version, operating system, protocol and authentication method, operation outcomes, retry counts, and non-sensitive error codes."
      >
        <span className="diagnostics-safety">Metadata only</span>
      </SettingsRow>
      <SettingsRow
        label="What is excluded"
        description="Credentials, secret values, hosts, usernames, paths, filenames, commands, file contents, and free-form error messages are never written."
      >
        <span className="diagnostics-safety">Private by design</span>
      </SettingsRow>
      <SettingsRow
        label="Saved files"
        description="Siftlane keeps at most four 256 KB log files. Open their folder to attach the relevant files to a support request, or clear every retained diagnostic log."
      >
        <span className="diagnostics-actions">
          <button
            type="button"
            className="secondary"
            disabled={busy !== null}
            onClick={() => void revealLogs()}
          >
            <FolderOpen size={14} />
            {busy === "reveal" ? "Opening…" : "Show logs folder"}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy !== null}
            onClick={() => void clearLogs()}
          >
            <Trash2 size={14} />
            {busy === "clear" ? "Clearing…" : "Clear logs"}
          </button>
        </span>
      </SettingsRow>
      {status && <p className="diagnostics-status" role="status">{status}</p>}
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
      {updatesEnabled && (
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
      {updatesEnabled && <UpdateDialog updater={updater} />}
    </div>
  );
}
