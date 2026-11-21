import { useId, useRef, useState } from "react";

/** The `{{partial` right before the caret, if the caret is inside an open placeholder. */
function openPlaceholder(text: string, caret: number): { start: number; prefix: string } | null {
  const m = /\{\{\s*([\w.]*)$/.exec(text.slice(0, caret));
  return m ? { start: m.index, prefix: m[1]! } : null;
}

/**
 * Text input (or textarea) for templates. Typing `{{` opens a list of fields filtered by
 * what follows; ↑/↓ move, Tab or Enter completes, Esc closes.
 */
export function TemplateInput({
  id,
  value,
  onChange,
  fields,
  multiline = false,
  placeholder,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  fields: string[];
  multiline?: boolean;
  placeholder?: string;
}) {
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const listId = useId();
  const [caret, setCaret] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);

  const ph = dismissed ? null : openPlaceholder(value, caret);
  const matches = ph ? fields.filter((f) => f.toLowerCase().includes(ph.prefix.toLowerCase())).slice(0, 8) : [];
  const open = matches.length > 0;

  const complete = (field: string) => {
    if (!ph) return;
    const rest = value.slice(caret).replace(/^[\w.]*\s*(\}\})?/, "");
    const next = `${value.slice(0, ph.start)}{{${field}}}${rest}`;
    const pos = ph.start + field.length + 4;
    onChange(next);
    requestAnimationFrame(() => {
      ref.current?.setSelectionRange(pos, pos);
      setCaret(pos);
    });
  };

  const props = {
    id,
    ref,
    className: "mono",
    value,
    placeholder,
    spellCheck: false,
    role: "combobox",
    "aria-autocomplete": "list" as const,
    "aria-expanded": open,
    "aria-controls": listId,
    "aria-activedescendant": open ? `${listId}-${Math.min(active, matches.length - 1)}` : undefined,
    onChange: (e: React.ChangeEvent<HTMLInputElement & HTMLTextAreaElement>) => {
      onChange(e.target.value);
      setCaret(e.target.selectionStart ?? e.target.value.length);
      setDismissed(false);
      setActive(0);
    },
    onSelect: (e: React.SyntheticEvent<HTMLInputElement & HTMLTextAreaElement>) =>
      setCaret(e.currentTarget.selectionStart ?? 0),
    onBlur: () => setDismissed(true),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (!open) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => (a + 1) % matches.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => (a - 1 + matches.length) % matches.length);
      } else if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        complete(matches[Math.min(active, matches.length - 1)]!);
      } else if (e.key === "Escape") {
        e.preventDefault();
        setDismissed(true);
      }
    },
  };

  return (
    <div className="tpl">
      {multiline ? <textarea rows={3} {...props} /> : <input type="text" {...props} />}
      {open && (
        <ul className="tpl-list" id={listId} role="listbox">
          {matches.map((f, i) => (
            <li
              key={f}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? "tpl-opt on" : "tpl-opt"}
              // mousedown, so the input doesn't blur (and close the list) first
              onMouseDown={(e) => {
                e.preventDefault();
                complete(f);
              }}
            >
              {f}
            </li>
          ))}
        </ul>
      )}
      <span className="re-hint">
        Type <kbd>{"{{"}</kbd> to insert a field.
      </span>
    </div>
  );
}
