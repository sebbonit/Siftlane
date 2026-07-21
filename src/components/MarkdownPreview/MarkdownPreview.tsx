import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function MarkdownPreview({ content }: { content: string }) {
  return (
    <div className="markdown-preview" aria-label="Markdown preview">
      {content.trim() ? (
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      ) : (
        <p className="markdown-preview-empty">This file is empty.</p>
      )}
    </div>
  );
}
