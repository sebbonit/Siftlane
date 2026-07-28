import { formatGithubReleaseNotes, parseGithubChangeItems } from "../../lib/githubReleaseNotes";
import { MarkdownPreview } from "../MarkdownPreview/MarkdownPreview";
import { SafeExternalLink } from "../SafeExternalLink";

export function UpdateReleaseNotes({ body }: { body: string | null | undefined }) {
  const raw = body ?? "";
  const items = parseGithubChangeItems(raw);

  if (items.length > 0) {
    return (
      <ul className="update-notes update-change-list" aria-label="Release notes">
        {items.map((item) => (
          <li key={`${item.prNumber}-${item.title}`}>
            <span>{item.title}</span>
            {" by "}
            <SafeExternalLink
              className="md-ref md-ref-mention"
              href={item.authorUrl}
              title={item.authorUrl}
            >
              @{item.author}
            </SafeExternalLink>
            {" in "}
            <SafeExternalLink
              className="md-ref md-ref-pr"
              href={item.prUrl}
              title={item.prUrl}
            >
              #{item.prNumber}
            </SafeExternalLink>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <MarkdownPreview content={formatGithubReleaseNotes(raw)} className="update-notes" emptyLabel={null} />
  );
}
