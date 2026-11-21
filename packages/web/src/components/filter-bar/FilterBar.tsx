import { print, tryParse } from "@alerting/filter";
import { ChevronDown, Star } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../Icon";
import { applyReplacement, computeSuggestions, formatError, type Suggestion } from "./suggestions";
import "./filter-bar.css";

/** Canonical text of a filter, so "a=b" and "a = b" count as the same starred filter. */
function canonical(text: string): string {
  const t = text.trim();
  const r = tryParse(t);
  return r.ok && r.tree ? print(r.tree) : t;
}

export interface FilterBarProps {
  value: string;
  onChange(text: string): void;
  /** Debounced 250 ms, only when the text parses. */
  onApply(text: string): void;
  fields: string[];
  valuesFor(field: string): string[];
  starred: string[];
  onToggleStar(text: string): void;
  inputRef?: React.RefObject<HTMLInputElement | null>;
}

export function FilterBar(props: FilterBarProps) {
  const { value, onChange, onApply, fields, valuesFor, starred, onToggleStar, inputRef } = props;
  const id = useId();
  const listId = `${id}-list`;
  const local = useRef<HTMLInputElement | null>(null);
  const [cursor, setCursor] = useState(value.length);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [menu, setMenu] = useState(false);
  const caret = useRef<number | null>(null);

  const parsed = useMemo(() => tryParse(value), [value]);
  const error = parsed.ok ? null : parsed.error;
  const trimmed = value.trim();
  const valid = parsed.ok && trimmed !== "";

  const apply = useRef(onApply);
  apply.current = onApply;
  useEffect(() => {
    if (!tryParse(value).ok) return;
    const t = setTimeout(() => apply.current(value), 250);
    return () => clearTimeout(t);
  }, [value]);

  const suggestions = open ? computeSuggestions({ text: value, cursor, fields, valuesFor, starred }) : [];
  const showList = open && suggestions.length > 0;
  const safeActive = Math.min(active, Math.max(0, suggestions.length - 1));

  useLayoutEffect(() => {
    if (caret.current !== null && local.current) {
      local.current.setSelectionRange(caret.current, caret.current);
      caret.current = null;
    }
  });

  function setRefs(el: HTMLInputElement | null) {
    local.current = el;
    if (inputRef) inputRef.current = el;
  }

  function accept(s: Suggestion) {
    if (s.kind === "starred") {
      onChange(s.insert); // the debounced effect applies it
      caret.current = s.insert.length;
      setCursor(s.insert.length);
    } else {
      const r = applyReplacement(value, cursor, s.insert);
      onChange(r.text);
      caret.current = r.cursor;
      setCursor(r.cursor);
    }
    setActive(0);
    // Keep the list open only if there is a follow-up to offer; it recomputes from the new text.
    setOpen(s.kind !== "starred");
    local.current?.focus();
  }

  /** The full filter text this row would produce, when that is a complete valid filter. */
  function resultingText(s: Suggestion): string | null {
    const text = (s.kind === "starred" ? s.insert : applyReplacement(value, cursor, s.insert).text).trim();
    return text !== "" && tryParse(text).ok ? text : null;
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        setOpen(false);
      }
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!showList) {
        setOpen(true);
        e.preventDefault();
        return;
      }
      e.preventDefault();
      const n = suggestions.length;
      setActive((safeActive + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
      return;
    }
    if ((e.key === "Enter" || e.key === "Tab") && showList) {
      const s = suggestions[safeActive];
      if (s) {
        e.preventDefault();
        accept(s);
      }
    }
  }

  function sync(el: HTMLInputElement) {
    setCursor(el.selectionStart ?? el.value.length);
  }

  const starredSet = useMemo(() => new Set(starred.map(canonical)), [starred]);
  const isStarred = trimmed !== "" && starredSet.has(canonical(trimmed));
  const optionId = (i: number) => `${id}-opt-${i}`;

  return (
    <div className="filter-bar">
      <div className={`filter${error ? " invalid" : valid ? " valid" : ""}`}>
        <input
          ref={setRefs}
          type="text"
          role="combobox"
          aria-label="Filter"
          aria-autocomplete="list"
          aria-expanded={showList}
          aria-controls={listId}
          aria-activedescendant={showList ? optionId(safeActive) : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          placeholder="alert.severity = critical"
          spellCheck={false}
          autoComplete="off"
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            sync(e.target);
            setActive(0);
            setOpen(true);
          }}
          onFocus={(e) => {
            sync(e.target);
            if (e.target.value === "") setOpen(true);
          }}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
          onKeyUp={(e) => {
            if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End")
              sync(e.currentTarget);
          }}
          onClick={(e) => sync(e.currentTarget)}
        />
        <button
          type="button"
          className={isStarred ? "icon-btn star-btn on" : "icon-btn star-btn"}
          aria-label={isStarred ? "Unstar filter" : "Star filter"}
          aria-pressed={isStarred}
          disabled={trimmed === "" || error !== null}
          onClick={() => onToggleStar(canonical(trimmed))}
        >
          <Icon as={Star} />
        </button>
        <div className="filter-menu">
          <button
            type="button"
            className="icon-btn"
            aria-label="Starred filters"
            aria-haspopup="true"
            aria-expanded={menu}
            onClick={() => setMenu((m) => !m)}
            onBlur={(e) => {
              if (!e.currentTarget.parentElement?.contains(e.relatedTarget)) setMenu(false);
            }}
          >
            <Icon as={ChevronDown} />
          </button>
          {menu && (
            <ul
              className="filter-dropdown filter-starred"
              aria-label="Starred filters list"
              onKeyDown={(e) => e.key === "Escape" && setMenu(false)}
            >
              {starred.length === 0 && <li className="filter-empty">No starred filters yet.</li>}
              {[...starred]
                .sort((a, b) => a.localeCompare(b))
                .map((s) => (
                  <li key={s}>
                    <button
                      type="button"
                      className="filter-option"
                      onBlur={(e) => {
                        if (!e.currentTarget.closest(".filter-menu")?.contains(e.relatedTarget)) setMenu(false);
                      }}
                      onClick={() => {
                        onChange(s);
                        onApply(s);
                        setMenu(false);
                      }}
                    >
                      {s}
                    </button>
                  </li>
                ))}
            </ul>
          )}
        </div>
        <ul id={listId} role="listbox" aria-label="Suggestions" className="filter-dropdown" hidden={!showList}>
          {showList &&
            suggestions.map((s, i) => (
              <li
                key={`${s.kind}:${s.insert}`}
                id={optionId(i)}
                role="option"
                aria-selected={i === safeActive}
                className={`filter-option${i === safeActive ? " active" : ""}`}
                // mousedown (not click) so the input keeps focus and blur does not close the list first
                onMouseDown={(e) => {
                  e.preventDefault();
                  accept(s);
                }}
              >
                <span className="filter-option-label">{s.label}</span>
                {s.description && <span className="filter-option-hint">{s.description}</span>}
                {(() => {
                  const text = resultingText(s);
                  if (!text) return null;
                  const on = starredSet.has(canonical(text));
                  return (
                    <button
                      type="button"
                      tabIndex={-1}
                      className={`filter-option-star${on ? " on" : ""}`}
                      aria-label={on ? "Unstar filter" : "Star filter"}
                      aria-pressed={on}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        onToggleStar(text);
                      }}
                    >
                      <Icon as={Star} />
                    </button>
                  );
                })()}
              </li>
            ))}
        </ul>
      </div>
      {error && (
        <>
          <div className="filter-marker" aria-hidden="true" style={{ ["--col" as string]: error.position - 1 }}>
            ^
          </div>
          <p id={`${id}-error`} className="filter-error" role="alert">
            {formatError(error)}
          </p>
        </>
      )}
    </div>
  );
}
