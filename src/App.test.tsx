import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import App from "./App";

describe("Siftlane shell", () => {
  it("opens the connection dialog from the empty shell", async () => {
    render(<App />);
    expect(await screen.findByText("Move files without the noise.")).toBeInTheDocument();
    expect(screen.queryByText("sftp.example.com")).not.toBeInTheDocument();
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
});
