import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import App from "./App";

describe("Siftlane shell", () => {
  it("opens the connection dialog from the empty shell", async () => {
    render(<App />);
    expect(await screen.findByText("Move files without the noise.")).toBeInTheDocument();
    expect(document.querySelector(".session-tabs")).toHaveClass("empty");
    expect(screen.queryByText("sftp.example.com")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    const buttons = await screen.findAllByRole("button", { name: /new connection/i });
    const button = buttons[0];
    expect(button).toBeDefined();
    await userEvent.click(button!);
    expect(screen.getByRole("dialog", { name: /new connection/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/display name/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Private key" }));
    expect(screen.getByRole("button", { name: /browse/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/choose an ssh private key/i)).toBeRequired();
  });

  it("persists a starred connection in the favorites section", async () => {
    render(<App />);
    const newButtons = await screen.findAllByRole("button", { name: /new connection/i });
    await userEvent.click(newButtons[0]!);
    await userEvent.type(screen.getByLabelText(/display name/i), "Demo server");
    await userEvent.type(screen.getByLabelText(/^host$/i), "demo.example.com");
    await userEvent.type(screen.getByLabelText(/username/i), "deploy");
    await userEvent.click(screen.getByRole("button", { name: "SSH agent" }));
    await userEvent.click(screen.getByRole("button", { name: /save & connect/i }));
    await waitFor(() => expect(document.querySelector(".session-tabs")).toHaveClass("visible"));

    const addFavorite = await screen.findByRole("button", {
      name: "Add Demo server to favorites",
    });
    await userEvent.click(addFavorite);
    expect(
      await screen.findAllByRole("button", { name: "Remove Demo server from favorites" }),
    ).toHaveLength(2);
    await userEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(screen.getByRole("button", { name: "Open favorite Demo server" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));

    const closeTab = document.querySelector(".session-tab svg");
    expect(closeTab).not.toBeNull();
    await userEvent.click(closeTab!);
    const favorites = screen.getByRole("button", { name: "Favorites" }).closest("section");
    expect(favorites).not.toBeNull();
    await userEvent.click(within(favorites!).getByRole("button", { name: "Demo server" }));
    expect(await screen.findByText(/Secure · SFTP/)).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: /connect to demo server/i })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByText("Move files without the noise.")).toBeInTheDocument();
    expect(document.querySelector(".session-tabs")).toHaveClass("empty");
  });

  it("offers FTP and FTPS with protocol-appropriate sign-in options", async () => {
    render(<App />);
    const newButtons = await screen.findAllByRole("button", { name: /new connection/i });
    await userEvent.click(newButtons[0]!);
    await userEvent.click(screen.getByRole("button", { name: "FTP" }));
    expect(screen.getByText(/does not encrypt your sign-in/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "SSH agent" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Anonymous" }));
    expect(screen.getByText(/standard anonymous FTP account/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^password$/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "FTPS" }));
    expect(screen.queryByText(/does not encrypt your sign-in/i)).not.toBeInTheDocument();
    expect(screen.getByText(/FTPS \(explicit TLS\) connection details/i)).toBeInTheDocument();
  });
});
