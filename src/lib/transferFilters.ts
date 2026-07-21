import type { TransferJob } from "../types";

export type TransferFilter = "active" | "completed" | "failed";

export function matchesTransferFilter(job: TransferJob, filter: TransferFilter) {
  if (filter === "active") return !["completed", "failed", "cancelled"].includes(job.state);
  if (filter === "completed") return job.state === "completed";
  return ["failed", "cancelled"].includes(job.state);
}

export function countTransferFilter(transfers: TransferJob[], filter: TransferFilter) {
  return transfers.filter((job) => matchesTransferFilter(job, filter)).length;
}
