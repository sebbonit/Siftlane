import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/ipc";
import { useAppStore } from "../store";
import type { TransferJob } from "../types";
import { TransferPanel } from "./TransferPanel";

const conflict: TransferJob = {
  id: "conflict-1",
  batch_id: "batch-1",
  profile_id: "profile-1",
  direction: "upload",
  source_path: "/local/report.txt",
  destination_path: "/remote/report.txt",
  partial_path: "/remote/report.txt.part",
  bytes_total: 12,
  bytes_transferred: 0,
  state: "waiting_for_conflict",
  conflict_policy: "ask",
  retry_count: 0,
  verification: "pending",
  speed_bytes_per_second: null,
  error: null,
  created_at: "2026-07-26T00:00:00Z",
  updated_at: "2026-07-26T00:00:00Z",
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useAppStore.setState({ transfers: [], transferPanelOpen: true });
});

describe("TransferPanel conflicts", () => {
  it("resolves a collision with keep both and can apply it to the batch", async () => {
    useAppStore.setState({
      transfers: [
        conflict,
        { ...conflict, id: "conflict-2", state: "queued", destination_path: "/remote/other.txt" },
      ],
      transferPanelOpen: true,
    });
    const resolve = vi.spyOn(api, "resolveConflict").mockResolvedValue([
      { ...conflict, state: "queued", conflict_policy: "rename" },
    ]);

    render(<TransferPanel />);
    expect(screen.getByRole("alertdialog")).toHaveTextContent("report.txt");
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: /keep both/i }));

    expect(resolve).toHaveBeenCalledWith("conflict-1", "rename", true);
  });

  it("shows both endpoints for a remote-to-remote transfer", () => {
    useAppStore.setState({
      transfers: [
        {
          ...conflict,
          id: "remote-copy",
          direction: "remote_to_remote",
          state: "running",
          source_endpoint: "Production (prod.example.com:22)",
          destination_endpoint: "Staging (staging.example.com:22)",
          source_path: "/var/www/report.txt",
          destination_path: "/srv/staging/report.txt",
        },
      ],
      transferPanelOpen: true,
    });

    render(<TransferPanel />);

    expect(screen.getByText("Remote to remote")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Production (prod.example.com:22):/var/www/report.txt → Staging (staging.example.com:22):/srv/staging/report.txt",
      ),
    ).toBeInTheDocument();
  });
});


describe("TransferPanel compact layout", () => {
  it("keeps large queues reachable when switching between two and one column", async () => {
    let resize: ResizeObserverCallback = () => {};
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) { resize = callback; }
      observe() {}
      disconnect() {}
    });
    useAppStore.setState({
      transfers: Array.from({ length: 240 }, (_, index) => ({
        ...conflict,
        id: `job-${index}`,
        source_path: `/local/file-${index}.txt`,
        state: index === 239 ? "failed" : "completed",
      })),
      transferPanelOpen: true,
    });
    const { container } = render(<TransferPanel />);
    const list = container.querySelector<HTMLDivElement>(".transfer-list")!;
    function resizeList(width: number) {
      act(() => resize([
        { contentRect: { width, height: 134 } } as ResizeObserverEntry,
      ], {} as ResizeObserver));
    }
    resizeList(1200);
    expect(list.style.gridTemplateColumns).toBe("repeat(2, minmax(0, 1fr))");
    expect(container.querySelectorAll(".transfer-row").length).toBeLessThan(30);
    fireEvent.scroll(list, { target: { scrollTop: 119 * 96 } });
    expect(screen.getByText("file-239.txt")).toBeInTheDocument();

    resizeList(800);
    expect(list.style.gridTemplateColumns).toBe("repeat(1, minmax(0, 1fr))");
    fireEvent.scroll(list, { target: { scrollTop: 239 * 96 } });
    expect(screen.getByText("file-239.txt")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Failed 1" }));
    expect(list.scrollTop).toBe(0);
    expect(screen.getByText("file-239.txt")).toBeInTheDocument();
    expect(container.querySelectorAll(".transfer-row")).toHaveLength(1);
  });
});
