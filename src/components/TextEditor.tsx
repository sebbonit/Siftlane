import { useEffect, useRef, useState } from "react";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { rust } from "@codemirror/lang-rust";
import {
  HighlightStyle,
  bracketMatching,
  foldGutter,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import {
  highlightSelectionMatches,
  openSearchPanel,
  searchKeymap,
} from "@codemirror/search";
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import {
  CircleAlert,
  FileEdit,
  LoaderCircle,
  LockKeyhole,
  Search,
  X,
} from "lucide-react";
import { api } from "../lib/ipc";
import type { EditableFile } from "../types";
import { MarkdownPreview } from "./MarkdownPreview";

const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--text)",
    backgroundColor: "var(--surface)",
  },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    fontSize: "11px",
    lineHeight: "1.65",
  },
  ".cm-content": { padding: "14px 0 18px", caretColor: "var(--teal)" },
  ".cm-line": { padding: "0 18px" },
  ".cm-gutters": {
    color: "var(--faint)",
    backgroundColor: "var(--surface-soft)",
    borderRight: "1px solid var(--border)",
  },
  ".cm-activeLine": {
    backgroundColor: "color-mix(in srgb, var(--teal-soft) 45%, transparent)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "var(--teal-soft)",
    color: "var(--teal)",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "color-mix(in srgb, var(--teal) 30%, transparent)",
  },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--teal)" },
});

const editorHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: "#087d7b" },
  { tag: [tags.string, tags.special(tags.string)], color: "#b26a2d" },
  { tag: [tags.number, tags.bool, tags.null], color: "#8d55a6" },
  {
    tag: [tags.comment, tags.docComment],
    color: "#7c8782",
    fontStyle: "italic",
  },
  { tag: [tags.tagName, tags.typeName, tags.className], color: "#156c98" },
  { tag: [tags.propertyName, tags.attributeName], color: "#926225" },
]);

export default function TextEditor({
  file,
  saving,
  onClose,
  onSave,
}: {
  file: EditableFile;
  saving: boolean;
  onClose: () => void;
  onSave: (content: string) => Promise<void>;
}) {
  const isMarkdown = file.language === "Markdown";
  const contentRef = useRef(file.content);
  const statsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [editorValue, setEditorValue] = useState(file.content);
  const [dirty, setDirty] = useState(false);
  const [stats, setStats] = useState(() => contentStats(file.content));
  const [viewMode, setViewMode] = useState<"preview" | "source">(
    isMarkdown ? "preview" : "source",
  );
  const [discardPrompt, setDiscardPrompt] = useState(false);
  const [formatting, setFormatting] = useState(false);
  const [formatError, setFormatError] = useState<string | null>(null);
  const editorView = useRef<EditorView | null>(null);
  const showingSource = !isMarkdown || viewMode === "source";
  const canFormat = [
    "HTML",
    "CSS",
    "JavaScript",
    "JSON",
    "Markdown",
    "Rust",
  ].includes(file.language);

  useEffect(
    () => () => {
      if (statsTimer.current) clearTimeout(statsTimer.current);
    },
    [],
  );

  function updateStatsSoon() {
    if (statsTimer.current) return;
    statsTimer.current = setTimeout(() => {
      statsTimer.current = null;
      setStats(contentStats(contentRef.current));
    }, 200);
  }

  function contentChanged(next: string) {
    contentRef.current = next;
    setDirty(next.length !== file.content.length || next !== file.content);
    updateStatsSoon();
  }

  function replaceContent(next: string) {
    contentRef.current = next;
    setEditorValue(next);
    setDirty(next.length !== file.content.length || next !== file.content);
    setStats(contentStats(next));
  }

  function close() {
    if (dirty) setDiscardPrompt(true);
    else onClose();
  }

  async function formatContent() {
    setFormatting(true);
    setFormatError(null);
    try {
      const content = contentRef.current;
      const formatted =
        file.language === "Rust"
          ? await api.formatRust(content)
          : await formatWithPrettier(content, file.language);
      replaceContent(formatted);
    } catch (reason) {
      setFormatError(errorMessage(reason));
    } finally {
      setFormatting(false);
    }
  }

  return (
    <div
      className="editor-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`Edit ${file.name}`}
    >
      <section className="editor-dialog">
        <header className="editor-header">
          <div className="editor-file-title">
            <span className="editor-file-icon">
              {file.privileged ? (
                <LockKeyhole size={16} />
              ) : (
                <FileEdit size={16} />
              )}
            </span>
            <div>
              <strong>{file.name}</strong>
              <small>{file.path}</small>
            </div>
          </div>
          <div className="editor-meta">
            <span>{file.language}</span>
            {file.privileged && <span>sudo</span>}
            <span>{dirty ? "Unsaved changes" : "Saved"}</span>
            <button aria-label="Close editor" onClick={close}>
              <X size={17} />
            </button>
          </div>
        </header>
        <div className="editor-toolbar">
          {isMarkdown ? (
            <div
              className="editor-view-mode"
              role="group"
              aria-label="Markdown view"
            >
              <button
                type="button"
                className={viewMode === "preview" ? "active" : ""}
                onClick={() => {
                  setEditorValue(contentRef.current);
                  setViewMode("preview");
                }}
              >
                Preview
              </button>
              <button
                type="button"
                className={viewMode === "source" ? "active" : ""}
                onClick={() => setViewMode("source")}
              >
                Source
              </button>
            </div>
          ) : (
            <span>Text editor</span>
          )}
          <div className="editor-toolbar-actions">
            {showingSource && (
              <button
                className="editor-search-button"
                title="Find and replace (⌘F)"
                onClick={() =>
                  editorView.current && openSearchPanel(editorView.current)
                }
              >
                <Search size={12} />
                Find
              </button>
            )}
            {canFormat && showingSource && (
              <button
                className="format-button"
                title="Format document (Shift+Alt+F)"
                disabled={formatting}
                onClick={() => void formatContent()}
              >
                {formatting && <LoaderCircle className="spin" size={12} />}
                Format
              </button>
            )}
          </div>
        </div>
        {formatError && (
          <div className="format-error">
            <CircleAlert size={14} />
            <span>{formatError}</span>
            <button
              aria-label="Dismiss formatting error"
              onClick={() => setFormatError(null)}
            >
              <X size={14} />
            </button>
          </div>
        )}
        {showingSource ? (
          <CodeEditor
            value={editorValue}
            language={file.language}
            onChange={contentChanged}
            onFormat={canFormat ? formatContent : undefined}
            onViewReady={(view) => {
              editorView.current = view;
            }}
          />
        ) : (
          <MarkdownPreview content={contentRef.current} />
        )}
        <footer className="editor-footer">
          <span>
            {stats.lines} lines · {stats.bytes} bytes
          </span>
          <div className="dialog-actions">
            <button className="secondary" onClick={close}>
              Cancel
            </button>
            <button
              className="primary"
              disabled={!dirty || saving}
              onClick={() => void onSave(contentRef.current)}
            >
              {saving ? (
                <LoaderCircle className="spin" size={15} />
              ) : (
                <FileEdit size={15} />
              )}
              Save file
            </button>
          </div>
        </footer>
        {discardPrompt && (
          <div className="discard-overlay">
            <section
              className="discard-dialog"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="discard-title"
            >
              <div className="discard-icon">
                <CircleAlert size={20} />
              </div>
              <div>
                <h2 id="discard-title">Discard unsaved changes?</h2>
                <p>
                  Your changes to <strong>{file.name}</strong> have not been
                  saved.
                </p>
              </div>
              <div className="dialog-actions">
                <button
                  className="secondary"
                  onClick={() => setDiscardPrompt(false)}
                >
                  Keep editing
                </button>
                <button className="danger-button" onClick={onClose}>
                  Discard changes
                </button>
              </div>
            </section>
          </div>
        )}
      </section>
    </div>
  );
}

function contentStats(content: string) {
  let lines = 1;
  for (const character of content) {
    if (character === "\n") lines += 1;
  }
  return { lines, bytes: new TextEncoder().encode(content).length };
}

async function formatWithPrettier(content: string, language: string) {
  const [{ format }, plugins] = await Promise.all([
    import("prettier/standalone"),
    prettierPlugins(language),
  ]);
  const common = { tabWidth: 2, printWidth: 100, singleQuote: true };
  return format(content, { ...common, ...plugins });
}

async function prettierPlugins(language: string) {
  if (language === "HTML") {
    const plugin = await import("prettier/plugins/html");
    return { parser: "html", plugins: [plugin] };
  }
  if (language === "CSS") {
    const plugin = await import("prettier/plugins/postcss");
    return { parser: "css", plugins: [plugin] };
  }
  if (language === "Markdown") {
    const plugin = await import("prettier/plugins/markdown");
    return { parser: "markdown", plugins: [plugin] };
  }
  const estree = await import("prettier/plugins/estree");
  if (language === "TypeScript") {
    const typescript = await import("prettier/plugins/typescript");
    return { parser: "typescript", plugins: [typescript, estree] };
  }
  const babel = await import("prettier/plugins/babel");
  return { parser: "babel", plugins: [babel, estree] };
}

function CodeEditor({
  value,
  language,
  onChange,
  onFormat,
  onViewReady,
}: {
  value: string;
  language: string;
  onChange: (value: string) => void;
  onFormat?: () => Promise<void>;
  onViewReady: (view: EditorView | null) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const changeHandler = useRef(onChange);
  const formatHandler = useRef(onFormat);
  const readyHandler = useRef(onViewReady);
  changeHandler.current = onChange;
  formatHandler.current = onFormat;
  readyHandler.current = onViewReady;

  useEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          history(),
          foldGutter(),
          drawSelection(),
          dropCursor(),
          indentOnInput(),
          bracketMatching(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          syntaxHighlighting(editorHighlight),
          getLanguageExtension(language),
          editorTheme,
          keymap.of([
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
            indentWithTab,
            {
              key: "Shift-Alt-f",
              run: () => {
                if (!formatHandler.current) return false;
                void formatHandler.current();
                return true;
              },
            },
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged)
              changeHandler.current(update.state.doc.toString());
          }),
        ],
      }),
      parent: host.current,
    });
    view.current = editor;
    readyHandler.current(editor);
    editor.focus();
    return () => {
      editor.destroy();
      view.current = null;
      readyHandler.current(null);
    };
  }, [language]);

  useEffect(() => {
    const editor = view.current;
    if (!editor || editor.state.doc.toString() === value) return;
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: value },
    });
  }, [value]);

  return (
    <div className="editor-code-wrap" ref={host} aria-label="File contents" />
  );
}

function getLanguageExtension(language: string): Extension {
  if (language === "HTML") return html();
  if (language === "CSS") return css();
  if (language === "JavaScript") return javascript({ jsx: true });
  if (language === "TypeScript")
    return javascript({ jsx: true, typescript: true });
  if (language === "JSON") return json();
  if (language === "Markdown") return markdown();
  if (language === "Rust") return rust();
  return [];
}

function errorMessage(reason: unknown) {
  if (typeof reason === "object" && reason && "message" in reason) {
    const detail =
      "detail" in reason && reason.detail ? `: ${String(reason.detail)}` : "";
    return `${String(reason.message)}${detail}`;
  }
  return String(reason);
}
