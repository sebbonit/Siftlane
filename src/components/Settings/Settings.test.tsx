import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import App from "../../App";

describe("Settings", () => {
  it("opens as a main window with category sidebar", async () => {
    render(<App />);
    await screen.findByText("Move files without the noise.");
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));

    expect(screen.getByRole("navigation", { name: "Settings categories" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /restore defaults/i })).toBeDisabled();
    expect(screen.getByRole("heading", { level: 2, name: "General" })).toBeInTheDocument();
    expect(screen.getByLabelText(/appearance/i)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("Move files without the noise.")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Transfers" }));
    expect(screen.getByRole("heading", { level: 2, name: "Transfers" })).toBeInTheDocument();
    expect(screen.getByLabelText(/global parallel transfers/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/per-host parallel transfers/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Connection" }));
    expect(screen.getByLabelText(/connect timeout/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "About" }));
    expect(screen.getByText(/version 0\.1\.0/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /back/i })).toBeInTheDocument();
  });

  it("autosaves preference changes", async () => {
    render(<App />);
    await screen.findByText("Move files without the noise.");
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(screen.getByRole("button", { name: "Transfers" }));

    const input = screen.getByLabelText(/global parallel transfers/i);
    await userEvent.clear(input);
    await userEvent.type(input, "5");
    expect(screen.getByRole("button", { name: /restore defaults/i })).toBeEnabled();

    await userEvent.click(screen.getByRole("button", { name: /back/i }));
    expect(await screen.findByText("Move files without the noise.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(screen.getByRole("button", { name: "Transfers" }));
    expect(screen.getByLabelText(/global parallel transfers/i)).toHaveValue(5);
  });

  it("restores default preferences", async () => {
    render(<App />);
    await screen.findByText("Move files without the noise.");
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(screen.getByRole("button", { name: "Transfers" }));

    const input = screen.getByLabelText(/global parallel transfers/i);
    await userEvent.clear(input);
    await userEvent.type(input, "8");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /restore defaults/i })).toBeEnabled();
    });

    await userEvent.click(screen.getByRole("button", { name: /restore defaults/i }));
    expect(screen.getByLabelText(/global parallel transfers/i)).toHaveValue(3);
    expect(screen.getByRole("button", { name: /restore defaults/i })).toBeDisabled();
  });
});
