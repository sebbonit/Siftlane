import type { MouseEvent, ReactNode } from "react";
import { api } from "../lib/ipc";

export function SafeExternalLink({
  href,
  className,
  title,
  children,
}: {
  href?: string;
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  const safeHref = httpsUrl(href);

  function open(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    if (!safeHref) return;
    void api.openExternalUrl(safeHref).catch(() => undefined);
  }

  return (
    <a
      href={safeHref ?? undefined}
      className={className}
      title={safeHref ? title : undefined}
      aria-disabled={!safeHref}
      onClick={open}
    >
      {children}
    </a>
  );
}

export function httpsUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}
