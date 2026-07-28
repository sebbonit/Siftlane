import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SafeExternalLink, httpsUrl } from "./SafeExternalLink";

describe("SafeExternalLink", () => {
  it("allows HTTPS and disables other schemes", () => {
    const { rerender } = render(
      <SafeExternalLink href="https://example.com/docs">Documentation</SafeExternalLink>,
    );
    expect(screen.getByRole("link")).toHaveAttribute("href", "https://example.com/docs");

    rerender(<SafeExternalLink href="javascript:alert(1)">Unsafe</SafeExternalLink>);
    expect(screen.getByText("Unsafe")).not.toHaveAttribute("href");
    expect(screen.getByText("Unsafe")).toHaveAttribute("aria-disabled", "true");
  });

  it("normalizes only HTTPS URLs", () => {
    expect(httpsUrl("https://example.com/docs")).toBe("https://example.com/docs");
    expect(httpsUrl("http://example.com")).toBeNull();
    expect(httpsUrl("not a url")).toBeNull();
  });
});
