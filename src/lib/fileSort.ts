import type { FileEntry } from "../types";

export type SortKey = "name" | "size" | "modified" | "mode";
export type SortDir = "asc" | "desc";

const NAME_COLLATOR = new Intl.Collator(undefined, {
  sensitivity: "base",
  numeric: true,
});

export function sortEntries(entries: FileEntry[], key: SortKey, dir: SortDir) {
  const factor = dir === "asc" ? 1 : -1;
  return [...entries].sort((left, right) => {
    const kindOrder =
      Number(left.kind !== "directory") - Number(right.kind !== "directory");
    if (kindOrder !== 0) return kindOrder;
    const compared = compareEntries(left, right, key);
    return compared === 0
      ? NAME_COLLATOR.compare(left.name, right.name)
      : compared * factor;
  });
}

function compareEntries(left: FileEntry, right: FileEntry, key: SortKey) {
  switch (key) {
    case "name":
      return NAME_COLLATOR.compare(left.name, right.name);
    case "size":
      return (left.size ?? -1) - (right.size ?? -1);
    case "modified":
      return (left.modified_at ?? "").localeCompare(right.modified_at ?? "");
    case "mode":
      return (left.permissions ?? -1) - (right.permissions ?? -1);
  }
}
