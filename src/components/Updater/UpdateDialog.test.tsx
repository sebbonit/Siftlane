import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { UpdateDialog } from "./UpdateDialog";
import type { AppUpdaterState } from "./useAppUpdater";

function makeUpdater(overrides: Partial<AppUpdaterState> = {}): AppUpdaterState {
  return {
    phase: "idle",
    update: null,
    progress: null,
    error: null,
    checkForUpdates: vi.fn(),
    installUpdate: vi.fn(),
    dismiss: vi.fn(),
    ...overrides,
  };
}

describe("UpdateDialog", () => {
  it("renders an available update and installs on confirm", async () => {
    const installUpdate = vi.fn();
    const dismiss = vi.fn();
    render(
      <UpdateDialog
        updater={makeUpdater({
          phase: "available",
          update: {
            version: "0.2.0",
            date: "2026-07-23T00:00:00Z",
            body: "Bug fixes",
          } as AppUpdaterState["update"],
          installUpdate,
          dismiss,
        })}
      />,
    );

    expect(screen.getByRole("dialog", { name: /update available/i })).toBeInTheDocument();
    expect(screen.getByText(/version 0\.2\.0/i)).toBeInTheDocument();
    expect(screen.getByText(/bug fixes/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /install update/i }));
    expect(installUpdate).toHaveBeenCalledOnce();
  });

  it("shows up-to-date status after a manual check", async () => {
    const dismiss = vi.fn();
    render(<UpdateDialog updater={makeUpdater({ phase: "up_to_date", dismiss })} />);
    expect(screen.getByRole("heading", { name: /up to date/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /ok/i }));
    expect(dismiss).toHaveBeenCalledOnce();
  });
});
