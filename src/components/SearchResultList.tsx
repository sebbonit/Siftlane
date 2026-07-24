import { File, Folder } from "lucide-react";
import type { SearchMatch } from "../types";
import type { PaneSide } from "./FilePane";

export function SearchResultList({
  matches,
  query,
  draft,
  side,
  running,
  onOpen,
}: {
  matches: SearchMatch[];
  query: string;
  draft: string;
  side: PaneSide;
  running: boolean;
  onOpen: (match: SearchMatch) => void;
}) {
  if (side === "remote" && !query.trim()) {
    return (
      <p className="search-empty">
        {draft.trim() ? "Press Enter or Search to begin" : "Type a name, then press Enter"}
      </p>
    );
  }
  if (!query.trim()) {
    return <p className="search-empty">Type a name to search recursively</p>;
  }
  if (!running && matches.length === 0) {
    return <p className="search-empty">No matching files or folders</p>;
  }
  return (
    <ul className="search-results" aria-label="Search results">
      {matches.map((match) => (
        <li key={`${match.kind}:${match.path}`}>
          <button type="button" onClick={() => onOpen(match)}>
            {match.kind === "directory" ? <Folder size={14} /> : <File size={14} />}
            <span>
              <strong>{match.name}</strong>
              <small>{match.parent_path}</small>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
