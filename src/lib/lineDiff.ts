export type DiffKind = "same" | "added" | "removed";

export interface DiffRow {
  kind: DiffKind;
  beforeLine: number | null;
  afterLine: number | null;
  before: string;
  after: string;
}

const MAX_LCS_LINES = 400;

export function buildLineDiff(before: string, after: string): DiffRow[] {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  if (beforeLines.length > MAX_LCS_LINES || afterLines.length > MAX_LCS_LINES) {
    return positionalDiff(beforeLines, afterLines);
  }

  const widths = afterLines.length + 1;
  const table = new Uint16Array((beforeLines.length + 1) * widths);
  for (let left = beforeLines.length - 1; left >= 0; left -= 1) {
    for (let right = afterLines.length - 1; right >= 0; right -= 1) {
      const index = left * widths + right;
      table[index] =
        beforeLines[left] === afterLines[right]
          ? (table[(left + 1) * widths + right + 1] ?? 0) + 1
          : Math.max(
              table[(left + 1) * widths + right] ?? 0,
              table[index + 1] ?? 0,
            );
    }
  }

  const rows: DiffRow[] = [];
  let left = 0;
  let right = 0;
  while (left < beforeLines.length || right < afterLines.length) {
    if (
      left < beforeLines.length &&
      right < afterLines.length &&
      beforeLines[left] === afterLines[right]
    ) {
      rows.push({
        kind: "same",
        beforeLine: left + 1,
        afterLine: right + 1,
        before: beforeLines[left] ?? "",
        after: afterLines[right] ?? "",
      });
      left += 1;
      right += 1;
    } else if (
      right < afterLines.length &&
      (left === beforeLines.length ||
        (table[left * widths + right + 1] ?? 0) >=
          (table[(left + 1) * widths + right] ?? 0))
    ) {
      rows.push({
        kind: "added",
        beforeLine: null,
        afterLine: right + 1,
        before: "",
        after: afterLines[right] ?? "",
      });
      right += 1;
    } else {
      rows.push({
        kind: "removed",
        beforeLine: left + 1,
        afterLine: null,
        before: beforeLines[left] ?? "",
        after: "",
      });
      left += 1;
    }
  }
  return rows;
}

function positionalDiff(before: string[], after: string[]): DiffRow[] {
  const count = Math.max(before.length, after.length);
  return Array.from({ length: count }, (_, index) => {
    const left = before[index];
    const right = after[index];
    if (left === right) {
      return {
        kind: "same",
        beforeLine: index + 1,
        afterLine: index + 1,
        before: left ?? "",
        after: right ?? "",
      };
    }
    if (left == null) {
      return {
        kind: "added",
        beforeLine: null,
        afterLine: index + 1,
        before: "",
        after: right ?? "",
      };
    }
    return {
      kind: "removed",
      beforeLine: index + 1,
      afterLine: right == null ? null : index + 1,
      before: left,
      after: right ?? "",
    };
  });
}

function splitLines(value: string): string[] {
  const lines = value.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}
