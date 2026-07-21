import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Folder, LoaderCircle } from "lucide-react";
import { joinPath, pathSuggestParts } from "../lib/paths";

export function PathSuggestInput({
  value,
  remote,
  placeholder,
  disabled,
  onChange,
  onListDirectories,
}: {
  value: string;
  remote: boolean;
  placeholder?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  onListDirectories: (parentPath: string) => Promise<string[]>;
}) {
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listDirectoriesRef = useRef(onListDirectories);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const requestId = useRef(0);
  listDirectoriesRef.current = onListDirectories;

  useEffect(() => {
    const { parent, prefix } = pathSuggestParts(value, remote);
    const timer = window.setTimeout(() => {
      const id = ++requestId.current;
      setLoading(true);
      void listDirectoriesRef
        .current(parent)
        .then((names) => {
          if (id !== requestId.current) return;
          const needle = prefix.toLowerCase();
          const next = names
            .filter((name) => !needle || name.toLowerCase().startsWith(needle))
            .sort((left, right) => left.localeCompare(right))
            .map((name) => joinPath(parent, name, remote));
          setSuggestions(next);
          setActiveIndex(0);
        })
        .catch(() => {
          if (id !== requestId.current) return;
          setSuggestions([]);
        })
        .finally(() => {
          if (id === requestId.current) setLoading(false);
        });
    }, 140);
    return () => window.clearTimeout(timer);
  }, [value, remote]);

  useEffect(() => {
    const list = listRef.current;
    if (!list || !open) return;
    const active = list.querySelector<HTMLElement>(`[data-suggest-index="${activeIndex}"]`);
    if (!active) return;
    const listRect = list.getBoundingClientRect();
    const itemRect = active.getBoundingClientRect();
    if (itemRect.top < listRect.top) {
      list.scrollTop -= listRect.top - itemRect.top;
    } else if (itemRect.bottom > listRect.bottom) {
      list.scrollTop += itemRect.bottom - listRect.bottom;
    }
  }, [activeIndex, open, suggestions]);

  function applySuggestion(next: string) {
    onChange(`${next}${remote || !next.includes("\\") ? "/" : "\\"}`);
    setOpen(true);
    inputRef.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (!open || suggestions.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % suggestions.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + suggestions.length) % suggestions.length);
      return;
    }
    if (event.key === "Enter" || (event.key === "Tab" && !event.shiftKey)) {
      event.preventDefault();
      const selected = suggestions[activeIndex] ?? suggestions[0];
      if (selected) applySuggestion(selected);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  }

  return (
    <div className="path-suggest">
      <input
        ref={inputRef}
        autoFocus
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        spellCheck={false}
        required
        role="combobox"
        aria-expanded={open && suggestions.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          open && suggestions[activeIndex] ? `${listId}-${activeIndex}` : undefined
        }
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        onKeyDown={onKeyDown}
      />
      {loading && <LoaderCircle className="spin path-suggest-spinner" size={14} />}
      {open && suggestions.length > 0 && (
        <ul ref={listRef} id={listId} className="path-suggest-list" role="listbox">
          {suggestions.map((suggestion, index) => (
            <li key={suggestion} role="presentation">
              <button
                id={`${listId}-${index}`}
                type="button"
                role="option"
                data-suggest-index={index}
                aria-selected={index === activeIndex}
                className={index === activeIndex ? "active" : ""}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => applySuggestion(suggestion)}
              >
                <Folder size={13} />
                <span>{suggestion}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
