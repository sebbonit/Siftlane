import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LoadingOverlay } from "./LoadingOverlay";

describe("LoadingOverlay", () => {
  it("shows the label and optional detail", () => {
    render(<LoadingOverlay label="Downloading preview…" detail="photo.png" />);
    expect(screen.getByRole("status", { name: "Downloading preview…" })).toBeInTheDocument();
    expect(screen.getByText("photo.png")).toBeInTheDocument();
  });

  it("calls onCancel from the Cancel button and Escape", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<LoadingOverlay label="Downloading preview…" onCancel={onCancel} />);

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);

    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});
