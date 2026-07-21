import { useEffect, useState } from "react";
import { CircleAlert, LoaderCircle, X } from "lucide-react";
import {
  capitalize,
  formatBytes,
  formatDate,
  formatPermissions,
  formatPermissionsSymbolic,
  parsePermissionsOctal,
  permissionsOctal,
} from "../lib/format";
import type { FileEntry } from "../types";

const PERMISSION_BITS = [
  { label: "Owner", shift: 6 },
  { label: "Group", shift: 3 },
  { label: "Others", shift: 0 },
] as const;

const BIT_FLAGS = [
  { label: "Read", mask: 4 },
  { label: "Write", mask: 2 },
  { label: "Execute", mask: 1 },
] as const;

export function FileInfoDialog({
  entry,
  canEditPermissions,
  saving,
  onClose,
  onSavePermissions,
  onResolveDirectorySize,
}: {
  entry: FileEntry;
  canEditPermissions: boolean;
  saving: boolean;
  onClose: () => void;
  onSavePermissions: (permissions: number) => Promise<void>;
  onResolveDirectorySize?: (path: string) => Promise<number>;
}) {
  const initial = entry.permissions ?? 0o644;
  const [mode, setMode] = useState(initial);
  const [octal, setOctal] = useState(permissionsOctal(initial) || "644");
  const [error, setError] = useState<string | null>(null);
  const [contentSize, setContentSize] = useState<number | null>(entry.size);
  const [sizing, setSizing] = useState(entry.kind === "directory" && entry.size == null);
  const dirty = canEditPermissions && (mode & 0o777) !== ((entry.permissions ?? 0) & 0o777);

  useEffect(() => {
    if (entry.kind !== "directory") {
      setContentSize(entry.size);
      setSizing(false);
      return;
    }
    if (entry.size != null) {
      setContentSize(entry.size);
      setSizing(false);
      return;
    }
    if (!onResolveDirectorySize) {
      setContentSize(null);
      setSizing(false);
      return;
    }
    let cancelled = false;
    setSizing(true);
    void onResolveDirectorySize(entry.path)
      .then((size) => {
        if (!cancelled) setContentSize(size);
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(
            reason instanceof Error
              ? reason.message
              : String((reason as { message?: string }).message ?? reason),
          );
        }
      })
      .finally(() => {
        if (!cancelled) setSizing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [entry.kind, entry.path, entry.size, onResolveDirectorySize]);

  function applyMode(next: number) {
    setMode(next);
    setOctal(permissionsOctal(next));
    setError(null);
  }

  function toggleBit(shift: number, mask: number) {
    const bit = mask << shift;
    applyMode(mode & bit ? mode & ~bit : mode | bit);
  }

  function onOctalChange(value: string) {
    setOctal(value);
    const parsed = parsePermissionsOctal(value);
    if (parsed != null) {
      setMode(parsed & 0o777);
      setError(null);
    }
  }

  async function save() {
    const parsed = parsePermissionsOctal(octal);
    if (parsed == null) {
      setError("Enter a valid octal mode like 644 or 0755.");
      return;
    }
    setError(null);
    try {
      await onSavePermissions(parsed & 0o777);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : String((reason as { message?: string }).message ?? reason),
      );
    }
  }

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="file-info-title">
        <header>
          <div>
            <h2 id="file-info-title">Get Info</h2>
            <p>{entry.name}</p>
          </div>
          <button aria-label="Close dialog" onClick={onClose}>
            <X size={17} />
          </button>
        </header>
        <div className="file-info-content">
          <dl>
            <div>
              <dt>Kind</dt>
              <dd>{capitalize(entry.kind)}</dd>
            </div>
            <div>
              <dt>Path</dt>
              <dd>{entry.path}</dd>
            </div>
            <div>
              <dt>Size</dt>
              <dd>
                {sizing ? (
                  <span className="file-info-sizing">
                    <LoaderCircle className="spin" size={12} /> Calculating…
                  </span>
                ) : (
                  formatBytes(contentSize)
                )}
              </dd>
            </div>
            <div>
              <dt>Modified</dt>
              <dd>{formatDate(entry.modified_at)}</dd>
            </div>
            <div>
              <dt>Permissions</dt>
              <dd>
                {formatPermissions(mode)} ({formatPermissionsSymbolic(mode)})
              </dd>
            </div>
            {entry.symlink_target && (
              <div>
                <dt>Symlink</dt>
                <dd>{entry.symlink_target}</dd>
              </div>
            )}
            {entry.hidden && (
              <div>
                <dt>Hidden</dt>
                <dd>Yes</dd>
              </div>
            )}
          </dl>

          {canEditPermissions ? (
            <div className="file-info-permissions">
              <label>
                Mode (octal)
                <input
                  type="text"
                  value={octal}
                  onChange={(event) => onOctalChange(event.target.value)}
                  spellCheck={false}
                  maxLength={4}
                  aria-label="Permission mode octal"
                />
              </label>
              <div className="permission-grid" role="group" aria-label="Permission bits">
                {PERMISSION_BITS.map((group) => (
                  <div key={group.label}>
                    <strong>{group.label}</strong>
                    {BIT_FLAGS.map((bit) => (
                      <label key={bit.label} className="checkbox">
                        <input
                          type="checkbox"
                          checked={Boolean((mode >> group.shift) & bit.mask)}
                          onChange={() => toggleBit(group.shift, bit.mask)}
                        />
                        {bit.label}
                      </label>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="file-info-note">
              Permission editing is unavailable for this location or protocol.
            </p>
          )}

          {error && (
            <div className="dialog-error" role="alert">
              <CircleAlert size={14} />
              <span>{error}</span>
            </div>
          )}
        </div>
        <div className="dialog-actions">
          <button className="secondary" onClick={onClose}>
            Close
          </button>
          {canEditPermissions && (
            <button className="primary" disabled={!dirty || saving} onClick={() => void save()}>
              {saving ? "Saving…" : "Save permissions"}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
