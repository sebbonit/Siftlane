import { useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ChevronDown,
  ChevronRight,
  File,
  Pause,
  Play,
  RefreshCw,
  Trash2,
  GripVertical,
  Info,
  ArrowRightLeft,
  X,
} from "lucide-react";
import { capitalize, formatBytes } from "../lib/format";
import { api } from "../lib/ipc";
import {
  countTransferFilter,
  matchesTransferFilter,
  type TransferFilter,
} from "../lib/transferFilters";
import { useAppStore } from "../store";
import type { TransferJob, TransferPriority } from "../types";
import { TransferConflictDialog } from "./TransferConflictDialog";

const FILTERS: TransferFilter[] = ["all", "active", "completed", "failed"];

function transferRoute(job: TransferJob): string {
  if (job.direction === "remote_to_remote") {
    return `${job.source_endpoint ?? "Remote"}:${job.source_path} → ${job.destination_endpoint ?? "Remote"}:${job.destination_path}`;
  }
  // Keep local on the left to match the dual-pane layout: upload uses >, download uses <.
  return job.direction === "upload"
    ? `${job.source_path} > ${job.destination_path}`
    : `${job.destination_path} < ${job.source_path}`;
}

function transferStatus(job: TransferJob): string {
  if (job.error) return job.error;
  if (job.state === "completed" && job.verification === "sha256_verified") {
    return "Completed · SHA-256 verified";
  }
  if (job.state === "completed" && job.verification === "size_verified") {
    return "Completed · Size verified";
  }
  return capitalize(job.state.replaceAll("_", " "));
}

export function TransferPanel() {
  const { transfers, transferPanelOpen, toggleTransfers, setTransfers } = useAppStore();
  const [filter, setFilter] = useState<TransferFilter>("all");
  const [detailJobId, setDetailJobId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const filtered = transfers.filter((job) => matchesTransferFilter(job, filter));
  const clearableCount = countTransferFilter(transfers, filter);
  const conflict = transfers.find((job) => job.state === "waiting_for_conflict") ?? null;
  const batchRemaining =
    conflict?.batch_id == null
      ? 1
      : transfers.filter(
          (job) => job.batch_id === conflict.batch_id && !["completed", "cancelled"].includes(job.state),
        ).length;
  const remainingBytes = transfers.reduce(
    (sum, job) => sum + Math.max(0, (job.bytes_total ?? job.bytes_transferred) - job.bytes_transferred),
    0,
  );
  const aggregateSpeed = transfers.reduce(
    (sum, job) => sum + (job.state === "running" ? job.speed_bytes_per_second ?? 0 : 0),
    0,
  );
  const detailJob = transfers.find((job) => job.id === detailJobId) ?? null;

  async function act(job: TransferJob, action: "pause" | "resume" | "cancel" | "retry") {
    const updated = await api.controlTransfer(job.id, action);
    setTransfers(transfers.map((item) => (item.id === job.id ? updated : item)));
  }

  async function clearCategory() {
    if (clearableCount === 0) return;
    const remaining = await api.clearTransfers(filter);
    setTransfers(remaining);
  }

  async function controlAll(action: "pause" | "resume") {
    setTransfers(await api.controlAllTransfers(action));
  }

  async function setPriority(job: TransferJob, priority: TransferPriority) {
    setTransfers(await api.setTransferPriority(job.id, priority));
  }

  async function dropBefore(beforeId: string | null) {
    if (!draggingId || draggingId === beforeId) return;
    setTransfers(await api.reorderTransfer(draggingId, beforeId));
    setDraggingId(null);
  }

  async function resolveConflict(
    policy: "skip" | "overwrite" | "rename",
    applyToBatch: boolean,
  ) {
    if (!conflict) return;
    const updated = await api.resolveConflict(conflict.id, policy, applyToBatch);
    const ids = new Set(updated.map((job) => job.id));
    setTransfers([...updated, ...transfers.filter((job) => !ids.has(job.id))], {
      expandOnNew: false,
    });
  }

  return (
    <>
    <section className={`transfer-panel ${transferPanelOpen ? "open" : "closed"}`}>
      <header className="transfer-heading">
        <button className="transfer-title" onClick={toggleTransfers}>
          {transferPanelOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          <strong>Transfers</strong>
          <span>{transfers.filter((job) => job.state === "running").length}</span>
        </button>
        <nav aria-label="Transfer filters">
          {FILTERS.map((value) => (
            <button
              key={value}
              className={filter === value ? "active" : ""}
              onClick={() => setFilter(value)}
            >
              {capitalize(value)} <span>{countTransferFilter(transfers, value)}</span>
            </button>
          ))}
        </nav>
        <span className="queue-summary">
          {formatBytes(remainingBytes)} left · ETA {formatEta(remainingBytes, aggregateSpeed)}
        </span>
        <button className="transfer-clear" onClick={() => void controlAll("pause")}>
          <Pause size={13} /> Pause all
        </button>
        <button className="transfer-clear" onClick={() => void controlAll("resume")}>
          <Play size={13} /> Resume all
        </button>
        <button
          className="transfer-clear"
          title={`Clear ${filter} transfers`}
          aria-label={`Clear ${filter} transfers`}
          disabled={clearableCount === 0}
          onClick={() => void clearCategory()}
        >
          <Trash2 size={14} />
          Clear
        </button>
      </header>
      {transferPanelOpen && (
        <div className="transfer-list">
          <div className="transfer-list-header">
            <span>Name</span>
            <span>Direction</span>
            <span>Progress</span>
            <span>Speed</span>
            <span>Status</span>
            <span />
          </div>
          {filtered.map((job) => {
            const progress = job.bytes_total
              ? Math.min(100, (job.bytes_transferred / job.bytes_total) * 100)
              : 0;
            const route = transferRoute(job);
            const name = job.source_path.split(/[\\/]/).pop() || job.source_path;
            return (
              <div
                className="transfer-row"
                key={job.id}
                draggable={!job.state.includes("running")}
                onDragStart={() => setDraggingId(job.id)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={() => void dropBefore(job.id)}
              >
                <span className="transfer-name" title={route}>
                  <GripVertical size={13} />
                  <File size={15} />
                  <span className="transfer-name-text">
                    <strong>{name}</strong>
                    <small>{route}</small>
                  </span>
                </span>
                <span>
                  {job.direction === "upload" ? (
                    <ArrowUpFromLine size={14} />
                  ) : job.direction === "remote_to_remote" ? (
                    <ArrowRightLeft size={14} />
                  ) : (
                    <ArrowDownToLine size={14} />
                  )}
                  {capitalize(job.direction.replaceAll("_", " "))}
                  <select
                    aria-label={`Priority for ${name}`}
                    value={job.priority ?? "normal"}
                    onChange={(event) => void setPriority(job, event.target.value as TransferPriority)}
                  >
                    <option value="high">High</option>
                    <option value="normal">Normal</option>
                    <option value="low">Low</option>
                  </select>
                </span>
                <span className="progress-cell">
                  <span className="progress-track">
                    <i style={{ width: `${progress}%` }} />
                  </span>
                  <small>{Math.round(progress)}%</small>
                  <small>{formatEta(
                    Math.max(0, (job.bytes_total ?? job.bytes_transferred) - job.bytes_transferred),
                    job.speed_bytes_per_second ?? 0,
                  )}</small>
                </span>
                <span>
                  {job.speed_bytes_per_second
                    ? `${formatBytes(job.speed_bytes_per_second)}/s`
                    : "—"}
                </span>
                <span className={`state ${job.state}`}>
                  <i />
                  {transferStatus(job)}
                </span>
                <span className="row-actions">
                  <button title="Details" onClick={() => setDetailJobId(job.id)}>
                    <Info size={14} />
                  </button>
                  {job.state === "running" && (
                    <button title="Pause" onClick={() => void act(job, "pause")}>
                      <Pause size={14} />
                    </button>
                  )}
                  {["paused", "interrupted"].includes(job.state) && (
                    <button title="Resume" onClick={() => void act(job, "resume")}>
                      <Play size={14} />
                    </button>
                  )}
                  {job.state === "failed" && (
                    <button title="Retry" onClick={() => void act(job, "retry")}>
                      <RefreshCw size={14} />
                    </button>
                  )}
                  {!["completed", "cancelled"].includes(job.state) && (
                    <button title="Cancel" onClick={() => void act(job, "cancel")}>
                      <X size={14} />
                    </button>
                  )}
                </span>
              </div>
            );
          })}
          {filtered.length === 0 && (
            <div className="empty-transfers">
              {filter === "all" ? "No transfers" : `No ${filter} transfers`}
            </div>
          )}
        </div>
      )}
    </section>
    {conflict && (
      <TransferConflictDialog
        key={conflict.id}
        job={conflict}
        batchRemaining={batchRemaining}
        onResolve={resolveConflict}
      />
    )}
    {detailJob && (
      <aside className="transfer-detail" aria-label="Transfer details">
        <header>
          <strong>Transfer details</strong>
          <button aria-label="Close details" onClick={() => setDetailJobId(null)}><X size={15} /></button>
        </header>
        <dl>
          <dt>Created</dt><dd>{new Date(detailJob.created_at).toLocaleString()}</dd>
          <dt>Updated</dt><dd>{new Date(detailJob.updated_at).toLocaleString()}</dd>
          <dt>Partial path</dt><dd>{detailJob.partial_path}</dd>
          <dt>Priority</dt><dd>{capitalize(detailJob.priority ?? "normal")}</dd>
          <dt>Retries</dt><dd>{detailJob.retry_count}</dd>
          <dt>Error</dt><dd>{detailJob.error ?? "None"}</dd>
        </dl>
        {(detailJob.retry_history?.length ?? 0) > 0 && (
          <ol>
            {detailJob.retry_history?.map((retry) => (
              <li key={`${retry.at}:${retry.error}`}>{new Date(retry.at).toLocaleString()} — {retry.error}</li>
            ))}
          </ol>
        )}
      </aside>
    )}
    </>
  );
}

function formatEta(bytes: number, speed: number): string {
  if (bytes <= 0) return "0s";
  if (speed <= 0) return "—";
  const seconds = Math.ceil(bytes / speed);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3_600)}h ${Math.floor((seconds % 3_600) / 60)}m`;
}
