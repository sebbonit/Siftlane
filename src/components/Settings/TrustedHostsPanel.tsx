import { useEffect, useState } from "react";
import { CircleAlert, FileUp, KeyRound, LoaderCircle, ShieldCheck, Trash2 } from "lucide-react";
import { api } from "../../lib/ipc";
import type { TrustedHostKey } from "../../types";

function keyId(key: TrustedHostKey) {
  return `${key.host}:${key.port}:${key.algorithm}`;
}

function seenAt(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function TrustedHostsPanel() {
  const [keys, setKeys] = useState<TrustedHostKey[]>([]);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    setKeys(await api.listTrustedHosts());
  }

  useEffect(() => {
    void reload().catch((reason: unknown) =>
      setError(reason instanceof Error ? reason.message : "Could not load trusted hosts"),
    );
  }, []);

  async function importKnownHosts() {
    setError(null);
    setStatus(null);
    const path = await api.pickKnownHostsFile();
    if (!path) return;
    setWorking(true);
    try {
      const result = await api.importKnownHosts(path);
      await reload();
      setStatus(
        `Imported ${result.imported} host ${result.imported === 1 ? "key" : "keys"}${
          result.skipped ? `; skipped ${result.skipped} unsupported entries` : ""
        }.`,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not import known_hosts");
    } finally {
      setWorking(false);
    }
  }

  async function remove(key: TrustedHostKey) {
    setWorking(true);
    setError(null);
    try {
      await api.removeTrustedHost(key.host, key.port, key.algorithm);
      setKeys((current) => current.filter((item) => keyId(item) !== keyId(key)));
      setConfirming(null);
      setStatus(`Removed trust for ${key.host}:${key.port}.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not remove the trusted key");
    } finally {
      setWorking(false);
    }
  }

  return (
    <section className="settings-section trusted-hosts-panel">
      <div className="trusted-hosts-heading">
        <div>
          <h2>Trusted host keys</h2>
          <p>
            Siftlane connects only when the presented fingerprint matches this trust store.
          </p>
        </div>
        <button className="secondary" disabled={working} onClick={() => void importKnownHosts()}>
          {working ? <LoaderCircle className="spin" size={14} /> : <FileUp size={14} />}
          Import known_hosts…
        </button>
      </div>
      {status && <p className="trusted-host-status"><ShieldCheck size={14} />{status}</p>}
      {error && <p className="dialog-error"><CircleAlert size={14} />{error}</p>}
      <div className="trusted-host-list">
        {keys.length === 0 && (
          <div className="trusted-host-empty">
            <KeyRound size={22} />
            <strong>No trusted host keys</strong>
            <span>Keys appear here after first-use confirmation or known_hosts import.</span>
          </div>
        )}
        {keys.map((key) => (
          <article key={keyId(key)} className="trusted-host-row">
            <span className="trusted-host-icon"><ShieldCheck size={17} /></span>
            <div className="trusted-host-identity">
              <strong>{key.host}<small>:{key.port}</small></strong>
              <span>{key.algorithm}</span>
              <code>{key.fingerprint_sha256}</code>
            </div>
            <dl>
              <div><dt>First seen</dt><dd>{seenAt(key.first_seen_at)}</dd></div>
              <div><dt>Last seen</dt><dd>{seenAt(key.last_seen_at)}</dd></div>
            </dl>
            {confirming === keyId(key) ? (
              <div className="trusted-host-confirm">
                <span>Remove this trust decision?</span>
                <button className="secondary" onClick={() => setConfirming(null)}>Cancel</button>
                <button className="danger-button" disabled={working} onClick={() => void remove(key)}>
                  Remove key
                </button>
              </div>
            ) : (
              <button
                className="trusted-host-remove"
                aria-label={`Remove trusted key for ${key.host}`}
                onClick={() => setConfirming(keyId(key))}
              >
                <Trash2 size={14} />
                Remove
              </button>
            )}
          </article>
        ))}
      </div>
      <p className="trusted-host-footnote">
        Hashed, wildcard, revoked, and certificate-authority entries are deliberately skipped during
        import because they cannot be mapped to a concrete host trust decision.
      </p>
    </section>
  );
}
