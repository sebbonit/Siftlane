/** Classify and shorten GitHub URLs for release-note / markdown rendering. */

export type GithubLinkKind = "pr" | "issue" | "compare" | "mention" | "repo";

export type GithubLinkMeta = {
  kind: GithubLinkKind;
  label: string;
};

const GITHUB_HOST = /^(?:www\.)?github\.com$/i;

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
  // Profile / org root: github.com/username
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
 * Turn GitHub auto-generated release notes into friendlier markdown:
 * bare PR/issue/compare URLs and @mentions become short labeled links.
 */
export function formatGithubReleaseNotes(markdown: string): string {
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

  // Mentions not already inside a markdown link label or URL.
  out = out.replace(
    /(^|[^[\w/-])@([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?)\b/g,
    (_m, prefix: string, user: string) => `${prefix}[@${user}](https://github.com/${user})`,
  );

  return out;
}

export function githubLinkDisplayLabel(href: string, childrenText: string | null): string | null {
  const meta = classifyGithubHref(href);
  if (!meta) return null;
  if (childrenText == null) return meta.label;
  if (childrenText === href || /^https?:\/\//i.test(childrenText)) return meta.label;
  return null;
}
