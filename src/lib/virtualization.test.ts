import { describe, expect, it } from "vitest";
import { scrollTopForIndex, virtualRange } from "./virtualization";

describe("virtualRange", () => {
  it("clamps a stale scroll position after a list shrinks", () => {
    expect(
      virtualRange({
        itemCount: 250,
        itemHeight: 33,
        scrollTop: 30_000,
        viewportHeight: 330,
        overscan: 8,
      }),
    ).toEqual({ first: 241, last: 250 });
  });

  it("accounts for a header inside the scroll container", () => {
    expect(
      virtualRange({
        itemCount: 500,
        itemHeight: 44,
        scrollTop: 27 + 44 * 10,
        viewportHeight: 220,
        overscan: 2,
        headerHeight: 27,
      }),
    ).toEqual({ first: 8, last: 17 });
  });

  it("returns an empty range for an empty list", () => {
    expect(
      virtualRange({
        itemCount: 0,
        itemHeight: 33,
        scrollTop: 100,
        viewportHeight: 300,
        overscan: 8,
      }),
    ).toEqual({ first: 0, last: 0 });
  });
});

describe("scrollTopForIndex", () => {
  it("scrolls rows above and below the viewport into view", () => {
    expect(
      scrollTopForIndex({
        index: 2,
        itemHeight: 33,
        scrollTop: 330,
        viewportHeight: 165,
      }),
    ).toBe(66);
    expect(
      scrollTopForIndex({
        index: 20,
        itemHeight: 33,
        scrollTop: 330,
        viewportHeight: 165,
      }),
    ).toBe(528);
  });

  it("does not move when the row is already visible", () => {
    expect(
      scrollTopForIndex({
        index: 12,
        itemHeight: 33,
        scrollTop: 330,
        viewportHeight: 165,
      }),
    ).toBe(330);
  });
});
