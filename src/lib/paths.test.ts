import { describe, expect, it } from "vitest";
import { normalizeBookmarkPath, pathBasename, pathSuggestParts } from "./paths";

describe("pathSuggestParts", () => {
  it("splits remote paths into parent directory and typed prefix", () => {
    expect(pathSuggestParts("/var/ww", true)).toEqual({ parent: "/var", prefix: "ww" });
    expect(pathSuggestParts("/var/www/", true)).toEqual({ parent: "/var/www", prefix: "" });
    expect(pathSuggestParts("/", true)).toEqual({ parent: "/", prefix: "" });
    expect(pathSuggestParts("/v", true)).toEqual({ parent: "/", prefix: "v" });
  });

  it("splits local windows-style paths", () => {
    expect(pathSuggestParts("C:\\Users\\al", false)).toEqual({
      parent: "C:\\Users",
      prefix: "al",
    });
  });
});

describe("pathBasename", () => {
  it("returns the final segment for remote and local paths", () => {
    expect(pathBasename("/var/www/html", true)).toBe("html");
    expect(pathBasename("/var/www/html/", true)).toBe("html");
    expect(pathBasename("/", true)).toBe("/");
    expect(pathBasename("/Users/alex/Projects", false)).toBe("Projects");
  });
});

describe("normalizeBookmarkPath", () => {
  it("strips trailing separators while preserving roots", () => {
    expect(normalizeBookmarkPath("/var/www/html/", true)).toBe("/var/www/html");
    expect(normalizeBookmarkPath("//var/www/html", true)).toBe("/var/www/html");
    expect(normalizeBookmarkPath("/", true)).toBe("/");
    expect(normalizeBookmarkPath("/Users/alex/Projects/", false)).toBe("/Users/alex/Projects");
  });
});
