import { describe, expect, it } from "vitest";
import { buildLineDiff } from "./lineDiff";

describe("buildLineDiff", () => {
  it("aligns inserted and unchanged lines", () => {
    expect(buildLineDiff("one\ntwo\nthree\n", "one\nnew\ntwo\nthree\n")).toEqual([
      {
        kind: "same",
        beforeLine: 1,
        afterLine: 1,
        before: "one",
        after: "one",
      },
      {
        kind: "added",
        beforeLine: null,
        afterLine: 2,
        before: "",
        after: "new",
      },
      {
        kind: "same",
        beforeLine: 2,
        afterLine: 3,
        before: "two",
        after: "two",
      },
      {
        kind: "same",
        beforeLine: 3,
        afterLine: 4,
        before: "three",
        after: "three",
      },
    ]);
  });

  it("marks removed lines", () => {
    const rows = buildLineDiff("one\ntwo\n", "two\n");
    expect(rows[0]).toMatchObject({ kind: "removed", before: "one" });
    expect(rows[1]).toMatchObject({ kind: "same", after: "two" });
  });
});
