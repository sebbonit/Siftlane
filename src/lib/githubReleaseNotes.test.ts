import { describe, expect, it } from "vitest";
import {
  classifyGithubHref,
  formatGithubReleaseNotes,
  githubLinkDisplayLabel,
  parseGithubChangeItems,
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

describe("parseGithubChangeItems", () => {
  it("extracts titles, authors, and PR numbers from GitHub notes", () => {
    const input = [
      "## What's Changed",
      "* Polish GitHub links in markdown previews and release notes by @sebbonit in https://github.com/sebbonit/Siftlane/pull/24",
      "",
      "**Full Changelog**: https://github.com/sebbonit/Siftlane/compare/v0.2.4...v0.2.5",
    ].join("\n");

    expect(parseGithubChangeItems(input)).toEqual([
      {
        title: "Polish GitHub links in markdown previews and release notes",
        author: "sebbonit",
        authorUrl: "https://github.com/sebbonit",
        prNumber: "24",
        prUrl: "https://github.com/sebbonit/Siftlane/pull/24",
      },
    ]);
  });
});

describe("formatGithubReleaseNotes", () => {
  it("strips boilerplate and shortens refs for fallback markdown", () => {
    const input =
      "## What's Changed\n* Custom notes without a PR link\n\n**Full Changelog**: https://github.com/sebbonit/Siftlane/compare/v0.2.4...v0.2.5";
    expect(formatGithubReleaseNotes(input)).toBe("* Custom notes without a PR link");
  });
});

describe("githubLinkDisplayLabel", () => {
  it("always shortens PR and mention labels", () => {
    expect(
      githubLinkDisplayLabel(
        "https://github.com/sebbonit/Siftlane/pull/24",
        "https://github.com/sebbonit/Siftlane/pull/24",
      ),
    ).toBe("#24");
    expect(githubLinkDisplayLabel("https://github.com/sebbonit", "sebbonit")).toBe("@sebbonit");
    expect(githubLinkDisplayLabel("https://example.com/x", "https://example.com/x")).toBeNull();
  });
});
