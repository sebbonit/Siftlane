import type { ReactNode } from "react";
import type { Components } from "react-markdown";
import { classifyGithubHref, githubLinkDisplayLabel } from "../../lib/githubReleaseNotes";

function childText(children: ReactNode): string | null {
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) {
    const parts = children.map(childText);
    if (parts.every((part) => part != null)) return parts.join("");
  }
  return null;
}

export const markdownLinkComponents: Pick<Components, "a"> = {
  a({ href, children }) {
    const url = href ?? "";
    const meta = classifyGithubHref(url);
    const text = childText(children);
    const short = githubLinkDisplayLabel(url, text);
    const className = meta ? `md-ref md-ref-${meta.kind}` : undefined;

    return (
      <a href={url || undefined} className={className} title={url || undefined}>
        {short ?? children}
      </a>
    );
  },
};
