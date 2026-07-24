/** Classify and shorten GitHub URLs for release-note / markdown rendering. */

export type GithubLinkKind = "pr" | "issue" | "compare" | "mention" | "repo";

export type GithubLinkMeta = {
  kind: GithubLinkKind;
  label: string;
};

export type GithubChangeItem = {
  title: string;
  author: string;
  authorUrl: string;
  prNumber: string;
  prUrl: string;
};

const GITHUB_HOST = /^(?:www\.)?github\.com$/i;
const CHANGE_ITEM =
  /^\s*[*+-]\s+(.+?)\s+by\s+@([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\s+in\s+https:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)\s*$/;

export function classifyGithubHref(href: string): GithubLinkMeta | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (!GITHUB_HOST.test(url.hostname)) return null;

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length === 0) return null;

  const [ownerOrUser, repo, kind, id] = parts;

  if (parts.length >= 4 && kind === "pull" && id && /^\d+$/.test(id)) {
    return { kind: "pr", label: `#${id}` };
  }
  if (parts.length >= 4 && kind === "issues" && id && /^\d+$/.test(id)) {
    return { kind: "issue", label: `#${id}` };
  }
  if (parts.length >= 4 && kind === "compare") {
    const range = decodeURIComponent(parts.slice(3).join("/"));
    return { kind: "compare", label: range.replace(/\.\.\./g, " → ") };
  }
  if (
    parts.length === 1 &&
    ownerOrUser &&
    /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(ownerOrUser)
  ) {
    return { kind: "mention", label: `@${ownerOrUser}` };
  }
  if (parts.length >= 2 && ownerOrUser && repo) {
    return { kind: "repo", label: `${ownerOrUser}/${repo}` };
  }
  return null;
}

/**
 * Parse GitHub auto-generated "What's Changed" bullets into structured updater rows.
 * Ignores headings and the Full Changelog footer.
 */
export function parseGithubChangeItems(markdown: string): GithubChangeItem[] {
  const items: GithubChangeItem[] = [];
  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const match = line.match(CHANGE_ITEM);
    if (!match) continue;
    const title = match[1]?.trim();
    const author = match[2];
    const owner = match[3];
    const repo = match[4];
    const prNumber = match[5];
    if (!title || !author || !owner || !repo || !prNumber) continue;
    items.push({
      title,
      author,
      authorUrl: `https://github.com/${author}`,
      prNumber,
      prUrl: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
    });
  }
  return items;
}

function linkifyGithubRefs(markdown: string): string {
  let out = markdown;

  out = out.replace(
    /https:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g,
    (_m, owner: string, repo: string, num: string) =>
      `[#${num}](https://github.com/${owner}/${repo}/pull/${num})`,
  );

  out = out.replace(
    /https:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)/g,
    (_m, owner: string, repo: string, num: string) =>
      `[#${num}](https://github.com/${owner}/${repo}/issues/${num})`,
  );

  out = out.replace(
    /https:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/compare\/([^\s)<]+)/g,
    (_m, owner: string, repo: string, range: string) => {
      const label = decodeURIComponent(range).replace(/\.\.\./g, " → ");
      return `[${label}](https://github.com/${owner}/${repo}/compare/${range})`;
    },
  );

  out = out.replace(
    /(^|[^[\w/-])@([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?)\b/g,
    (_m, prefix: string, user: string) => `${prefix}[@${user}](https://github.com/${user})`,
  );

  return out;
}

/**
 * Fallback markdown when notes are not standard GitHub change bullets:
 * drop boilerplate, shorten PR/user refs.
 */
export function formatGithubReleaseNotes(markdown: string): string {
  let out = markdown.replace(/\r\n/g, "\n").trim();
  if (!out) return "";

  out = out.replace(/\n+(?:#{1,3}\s*)?\*?\*?Full Changelog\*?\*?:?[\s\S]*$/i, "");
  out = out.replace(/^#{1,3}\s*What's Changed\s*\n+/i, "");
  return linkifyGithubRefs(out).trim();
}

/** Always prefer short chip labels for PRs, issues, and @mentions. */
export function githubLinkDisplayLabel(href: string, childrenText: string | null): string | null {
  const meta = classifyGithubHref(href);
  if (!meta) return null;
  if (meta.kind === "pr" || meta.kind === "issue" || meta.kind === "mention") {
    return meta.label;
  }
  if (childrenText == null) return meta.label;
  if (childrenText === href || /^https?:\/\//i.test(childrenText)) return meta.label;
  return null;
}
