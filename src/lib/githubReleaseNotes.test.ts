import { describe, expect, it } from "vitest";
import {
  classifyGithubHref,
  formatGithubReleaseNotes,
  githubLinkDisplayLabel,
} from "./githubReleaseNotes";

describe("classifyGithubHref", () => {
  it("classifies pull requests, issues, compares, and mentions", () => {
    expect(classifyGithubHref("https://github.com/sebbonit/Siftlane/pull/23")).toEqual({
      kind: "pr",
      label: "#23",
    });
    expect(classifyGithubHref("https://github.com/sebbonit/Siftlane/issues/9")).toEqual({
      kind: "issue",
      label: "#9",
    });
    expect(classifyGithubHref("https://github.com/sebbonit/Siftlane/compare/v0.2.3...v0.2.4")).toEqual({
      kind: "compare",
      label: "v0.2.3 → v0.2.4",
    });
    expect(classifyGithubHref("https://github.com/sebbonit")).toEqual({
      kind: "mention",
      label: "@sebbonit",
    });
  });
});

describe("formatGithubReleaseNotes", () => {
  it("shortens GitHub release-note URLs and mentions", () => {
    const input =
      "## What's Changed\n* Render markdown release notes by @sebbonit in https://github.com/sebbonit/Siftlane/pull/23\n\n**Full Changelog**: https://github.com/sebbonit/Siftlane/compare/v0.2.3...v0.2.4";
    expect(formatGithubReleaseNotes(input)).toBe(
      "## What's Changed\n* Render markdown release notes by [@sebbonit](https://github.com/sebbonit) in [#23](https://github.com/sebbonit/Siftlane/pull/23)\n\n**Full Changelog**: [v0.2.3 → v0.2.4](https://github.com/sebbonit/Siftlane/compare/v0.2.3...v0.2.4)",
    );
  });
});

describe("githubLinkDisplayLabel", () => {
  it("replaces bare URL link text with a short label", () => {
    expect(
      githubLinkDisplayLabel("https://github.com/sebbonit/Siftlane/pull/23", "https://github.com/sebbonit/Siftlane/pull/23"),
    ).toBe("#23");
    expect(githubLinkDisplayLabel("https://github.com/sebbonit/Siftlane/pull/23", "#23")).toBeNull();
    expect(githubLinkDisplayLabel("https://example.com/x", "https://example.com/x")).toBeNull();
  });
});
