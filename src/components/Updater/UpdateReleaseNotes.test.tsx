import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UpdateReleaseNotes } from "./UpdateReleaseNotes";

describe("UpdateReleaseNotes", () => {
  it("renders GitHub change bullets as @mention and #PR chips", () => {
    const body = [
      "## What's Changed",
      "* Polish GitHub links in markdown previews and release notes by @sebbonit in https://github.com/sebbonit/Siftlane/pull/24",
      "",
      "**Full Changelog**: https://github.com/sebbonit/Siftlane/compare/v0.2.4...v0.2.5",
    ].join("\n");

    render(<UpdateReleaseNotes body={body} />);

    expect(screen.queryByText(/what's changed/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/full changelog/i)).not.toBeInTheDocument();
    expect(
      screen.getByText(/Polish GitHub links in markdown previews and release notes/),
    ).toBeInTheDocument();

    const mention = screen.getByRole("link", { name: "@sebbonit" });
    expect(mention).toHaveClass("md-ref-mention");
    expect(mention).toHaveAttribute("href", "https://github.com/sebbonit");

    const pr = screen.getByRole("link", { name: "#24" });
    expect(pr).toHaveClass("md-ref-pr");
    expect(pr).toHaveAttribute("href", "https://github.com/sebbonit/Siftlane/pull/24");
  });
});
