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
import type { TransferJob } from "../types";

const FILTERS: TransferFilter[] = ["active", "completed", "failed"];

export function TransferPanel() {
  const { transfers, transferPanelOpen, toggleTransfers, setTransfers } = useAppStore();
  const [filter, setFilter] = useState<TransferFilter>("active");
  const filtered = transfers.filter((job) => matchesTransferFilter(job, filter));
  const clearableCount = countTransferFilter(transfers, filter);

  async function act(job: TransferJob, action: "pause" | "resume" | "cancel" | "retry") {
    const updated = await api.controlTransfer(job.id, action);
    setTransfers(transfers.map((item) => (item.id === job.id ? updated : item)));
  }

  async function clearCategory() {
    if (clearableCount === 0) return;
    const remaining = await api.clearTransfers(filter);
    setTransfers(remaining);
  }

  return (
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
            return (
              <div className="transfer-row" key={job.id}>
                <span className="transfer-name">
                  <File size={15} />
                  {job.source_path.split(/[\\/]/).pop()}
                </span>
                <span>
                  {job.direction === "upload" ? (
                    <ArrowUpFromLine size={14} />
                  ) : (
                    <ArrowDownToLine size={14} />
                  )}
                  {capitalize(job.direction)}
                </span>
                <span className="progress-cell">
                  <span className="progress-track">
                    <i style={{ width: `${progress}%` }} />
                  </span>
                  <small>{Math.round(progress)}%</small>
                </span>
                <span>
                  {job.speed_bytes_per_second
                    ? `${formatBytes(job.speed_bytes_per_second)}/s`
                    : "—"}
                </span>
                <span className={`state ${job.state}`}>
                  <i />
                  {job.error ?? capitalize(job.state.replaceAll("_", " "))}
                </span>
                <span className="row-actions">
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
          {filtered.length === 0 && <div className="empty-transfers">No {filter} transfers</div>}
        </div>
      )}
    </section>
  );
}
