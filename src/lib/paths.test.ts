import { describe, expect, it } from "vitest";
import { pathSuggestParts } from "./paths";

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
