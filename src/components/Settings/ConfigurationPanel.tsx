import { useState, type FormEvent } from "react";
import {
  ArchiveRestore,
  CheckCircle2,
  CircleAlert,
  Download,
  FileJson2,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Upload,
  X,
} from "lucide-react";
import { api } from "../../lib/ipc";
import type {
  ConfigurationImportSummary,
  ConfigurationSummary,
  ConnectionProfile,
} from "../../types";

type SecretOperation =
  | { mode: "export"; path: string }
  | { mode: "import"; path: string; preview: ConfigurationSummary };

export function ConfigurationPanel({
  profiles,
  onImported,
}: {
  profiles: ConnectionProfile[];
  onImported: () => Promise<void>;
}) {
  const [working, setWorking] = useState<"export" | "encrypted" | "import" | null>(null);
  const [secretOperation, setSecretOperation] = useState<SecretOperation | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function exportPlain() {
    setWorking("export");
    setError(null);
    try {
      const path = await api.pickConfigurationExport(false);
      if (!path) return;
      const summary = await api.exportConfiguration(path, false);
      setResult(exportMessage(summary, false));
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setWorking(null);
    }
  }

  async function prepareEncryptedExport() {
    setWorking("encrypted");
    setError(null);
    try {
      const path = await api.pickConfigurationExport(true);
      if (path) setSecretOperation({ mode: "export", path });
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setWorking(null);
    }
  }

  async function prepareImport() {
    setWorking("import");
    setError(null);
    try {
      const path = await api.pickConfigurationImport();
      if (!path) return;
      const preview = await api.inspectConfiguration(path);
      if (preview.secrets_included) {
        setSecretOperation({ mode: "import", path, preview });
        return;
      }
      const imported = await api.importConfiguration(path);
      await onImported();
      setResult(importMessage(imported));
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setWorking(null);
    }
  }

  async function finishSecretOperation(passphrase: string) {
    if (!secretOperation) return;
    setWorking(secretOperation.mode === "export" ? "encrypted" : "import");
    setError(null);
    try {
      if (secretOperation.mode === "export") {
        const summary = await api.exportConfiguration(
          secretOperation.path,
          true,
          passphrase,
        );
        setResult(exportMessage(summary, true));
      } else {
        const imported = await api.importConfiguration(secretOperation.path, passphrase);
        await onImported();
        setResult(importMessage(imported));
      }
      setSecretOperation(null);
    } catch (reason) {
      setError(errorMessage(reason));
      throw reason;
    } finally {
      setWorking(null);
    }
  }

  const folders = new Set(
    profiles.map((profile) => profile.folder).filter((value): value is string => !!value),
  ).size;
  const tags = new Set(profiles.flatMap((profile) => profile.tags)).size;

  return (
    <>
      <section className="settings-section configuration-panel">
        <h2 className="settings-section-title">
          <span>Profiles &amp; data</span>
          <small>Versioned JSON · schema v1</small>
        </h2>
        <div className="configuration-overview">
          <span>
            <strong>{profiles.length}</strong>
            profiles
          </span>
          <span>
            <strong>{folders}</strong>
            folders
          </span>
          <span>
            <strong>{tags}</strong>
            tags
          </span>
        </div>
        <div className="configuration-cards">
          <article>
            <span className="configuration-card-icon">
              <FileJson2 size={19} />
            </span>
            <div>
              <h3>Portable configuration</h3>
              <p>
                Export profiles, bookmarks, and saved actions as readable versioned JSON.
                Credentials are excluded.
              </p>
            </div>
            <button
              className="secondary"
              disabled={working != null}
              onClick={() => void exportPlain()}
            >
              {working === "export" ? (
                <LoaderCircle className="spin" size={14} />
              ) : (
                <Download size={14} />
              )}
              Export JSON
            </button>
          </article>
          <article className="configuration-encrypted">
            <span className="configuration-card-icon">
              <LockKeyhole size={19} />
            </span>
            <div>
              <h3>Encrypted secret export</h3>
              <p>
                Explicitly include saved keyring passwords and key passphrases, protected with
                Argon2id and AES-256-GCM.
              </p>
            </div>
            <button
              className="secondary"
              disabled={working != null}
              onClick={() => void prepareEncryptedExport()}
            >
              {working === "encrypted" ? (
                <LoaderCircle className="spin" size={14} />
              ) : (
                <KeyRound size={14} />
              )}
              Export encrypted…
            </button>
          </article>
          <article>
            <span className="configuration-card-icon">
              <ArchiveRestore size={19} />
            </span>
            <div>
              <h3>Import and merge</h3>
              <p>
                Preview a Siftlane JSON document, validate its version, and merge records by
                stable ID. Encrypted files request their passphrase.
              </p>
            </div>
            <button
              className="secondary"
              disabled={working != null}
              onClick={() => void prepareImport()}
            >
              {working === "import" ? (
                <LoaderCircle className="spin" size={14} />
              ) : (
                <Upload size={14} />
              )}
              Import JSON…
            </button>
          </article>
        </div>
        <div className="configuration-security-note">
          <LockKeyhole size={14} />
          Plain exports never read the OS keyring. Secret export is a separate, deliberate action
          and writes a private file on Unix.
        </div>
        {result && (
          <div className="configuration-result success" role="status">
            <CheckCircle2 size={15} />
            <span>{result}</span>
            <button aria-label="Dismiss result" onClick={() => setResult(null)}>
              <X size={14} />
            </button>
          </div>
        )}
        {error && (
          <div className="configuration-result error" role="alert">
            <CircleAlert size={15} />
            <span>{error}</span>
            <button aria-label="Dismiss error" onClick={() => setError(null)}>
              <X size={14} />
            </button>
          </div>
        )}
      </section>
      {secretOperation && (
        <ConfigurationPassphraseDialog
          operation={secretOperation}
          saving={working != null}
          onClose={() => setSecretOperation(null)}
          onSubmit={finishSecretOperation}
        />
      )}
    </>
  );
}

function ConfigurationPassphraseDialog({
  operation,
  saving,
  onClose,
  onSubmit,
}: {
  operation: SecretOperation;
  saving: boolean;
  onClose: () => void;
  onSubmit: (passphrase: string) => Promise<void>;
}) {
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const exporting = operation.mode === "export";

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (passphrase.length < 12) {
      setLocalError("Use at least 12 characters.");
      return;
    }
    if (exporting && passphrase !== confirmation) {
      setLocalError("The passphrases do not match.");
      return;
    }
    setLocalError(null);
    try {
      await onSubmit(passphrase);
    } catch {
      // The parent shows the structured application error.
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        className="dialog configuration-passphrase-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={exporting ? "Encrypted secret export" : "Unlock configuration"}
      >
        <header>
          <div>
            <h2>{exporting ? "Protect exported secrets" : "Unlock encrypted secrets"}</h2>
            <p>
              {exporting
                ? "This passphrase is required to import the encrypted payload."
                : `Configuration v${operation.preview.version} contains encrypted keyring data.`}
            </p>
          </div>
          <button aria-label="Close dialog" onClick={onClose}>
            <X size={17} />
          </button>
        </header>
        <form onSubmit={submit}>
          {!exporting && (
            <div className="configuration-import-preview">
              <span>{operation.preview.profiles} profiles</span>
              <span>{operation.preview.bookmarks} bookmarks</span>
              <span>{operation.preview.saved_actions} saved actions</span>
            </div>
          )}
          <label>
            Export passphrase
            <input
              autoFocus
              type="password"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              autoComplete="new-password"
            />
          </label>
          {exporting && (
            <label>
              Confirm passphrase
              <input
                type="password"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                autoComplete="new-password"
              />
            </label>
          )}
          <p className="configuration-passphrase-note">
            Siftlane cannot recover this passphrase. It is never stored in the export or app
            preferences.
          </p>
          {localError && <p className="dialog-error">{localError}</p>}
          <div className="dialog-actions">
            <button type="button" className="secondary" onClick={onClose}>
              Cancel
            </button>
            <button className="primary" disabled={saving || passphrase.length < 12}>
              {saving && <LoaderCircle className="spin" size={14} />}
              {exporting ? "Encrypt & export" : "Unlock & import"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function exportMessage(summary: ConfigurationSummary, encrypted: boolean) {
  return `Exported ${summary.profiles} profiles, ${summary.bookmarks} bookmarks, and ${summary.saved_actions} saved actions${encrypted ? " with an encrypted secret payload" : " without secrets"}.`;
}

function importMessage(summary: ConfigurationImportSummary) {
  return `Imported ${summary.profiles} profiles, ${summary.bookmarks} bookmarks, ${summary.saved_actions} saved actions, and ${summary.secrets_imported} secrets.`;
}

function errorMessage(reason: unknown) {
  if (typeof reason === "object" && reason && "message" in reason) {
    return String(reason.message);
  }
  return String(reason);
}
