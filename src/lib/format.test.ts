import { describe, expect, it } from "vitest";
import { formatDate } from "./format";

describe("formatDate", () => {
  it("returns an em dash for null or empty values", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDate("")).toBe("—");
  });

  it("returns an em dash for invalid timestamps", () => {
    expect(formatDate("not-a-date")).toBe("—");
  });

  it("formats valid ISO timestamps", () => {
    const formatted = formatDate("2026-07-28T13:00:00.000Z");
    expect(formatted).not.toBe("—");
    expect(formatted.length).toBeGreaterThan(0);
  });
});
