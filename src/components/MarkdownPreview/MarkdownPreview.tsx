import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type MarkdownPreviewProps = {
  content: string;
  className?: string;
  /** When null, blank content renders nothing instead of an empty-state message. */
  emptyLabel?: string | null;
};

export function MarkdownPreview({
  content,
  className = "markdown-preview",
  emptyLabel = "This file is empty.",
}: MarkdownPreviewProps) {
  const trimmed = content.trim();
  if (!trimmed) {
    if (emptyLabel == null) return null;
    return (
      <div className={className} aria-label="Markdown preview">
        <p className="markdown-preview-empty">{emptyLabel}</p>
      </div>
    );
  }

  return (
    <div className={className} aria-label="Markdown preview">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{trimmed}</ReactMarkdown>
    </div>
  );
}
