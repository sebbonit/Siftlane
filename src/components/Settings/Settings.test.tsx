import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import App from "../../App";
import { api } from "../../lib/ipc";

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
    expect(screen.getByRole("option", { name: "Midnight" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Ocean" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Graphite" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("Move files without the noise.")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Transfers" }));
    expect(screen.getByRole("heading", { level: 2, name: "Transfers" })).toBeInTheDocument();
    expect(screen.getByLabelText(/global parallel transfers/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/per-host parallel transfers/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/expand on new transfer/i)).toBeChecked();

    await userEvent.click(screen.getByRole("button", { name: "Connection" }));
    expect(screen.getByLabelText(/connect timeout/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Trusted hosts" }));
    expect(
      screen.getByRole("heading", { level: 2, name: "Trusted host keys" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /import known_hosts/i })).toBeInTheDocument();
    expect(screen.getByText(/keys appear here after first-use confirmation/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "About" }));
    expect(screen.getByText(/version 0\.2\.1/i)).toBeInTheDocument();
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

  it("offers opt-in privacy-safe diagnostic logs and retention controls", async () => {
    render(<App />);
    await screen.findByText("Move files without the noise.");
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(screen.getByRole("button", { name: "Diagnostics" }));

    const toggle = screen.getByLabelText("Save diagnostic logs");
    expect(toggle).not.toBeChecked();
    expect(
      screen.getByText(/credentials, secret values, hosts, usernames, paths/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/at most four 256 KB log files/i)).toBeInTheDocument();

    await userEvent.click(toggle);
    expect(toggle).toBeChecked();
    expect(screen.getByRole("button", { name: "Show logs folder" })).toBeEnabled();

    await userEvent.click(screen.getByRole("button", { name: "Clear logs" }));
    expect(await screen.findByRole("status")).toHaveTextContent(/logs were cleared/i);
  });

  it("reverts the diagnostics toggle when saving fails", async () => {
    const save = vi
      .spyOn(api, "savePreferences")
      .mockRejectedValueOnce(new Error("storage unavailable"));
    render(<App />);
    await screen.findByText("Move files without the noise.");
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(screen.getByRole("button", { name: "Diagnostics" }));

    const toggle = screen.getByLabelText("Save diagnostic logs");
    await userEvent.click(toggle);

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be saved/i);
    await waitFor(() => expect(toggle).not.toBeChecked());
    save.mockRestore();
  });

  it("offers plain and explicitly encrypted configuration export", async () => {
    render(<App />);
    await screen.findByText("Move files without the noise.");
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(screen.getByRole("button", { name: "Profiles & data" }));

    expect(
      screen.getByRole("heading", { level: 2, name: /Profiles & data/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/credentials are excluded/i)).toBeInTheDocument();
    expect(screen.getByText(/Argon2id and AES-256-GCM/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Export JSON" }));
    expect(await screen.findByText(/without secrets/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Export encrypted/i }));
    const dialog = screen.getByRole("dialog", { name: "Encrypted secret export" });
    expect(dialog).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Export passphrase"), "long test passphrase");
    await userEvent.type(screen.getByLabelText("Confirm passphrase"), "long test passphrase");
    await userEvent.click(screen.getByRole("button", { name: "Encrypt & export" }));
    expect(await screen.findByText(/encrypted secret payload/i)).toBeInTheDocument();
  });
});
