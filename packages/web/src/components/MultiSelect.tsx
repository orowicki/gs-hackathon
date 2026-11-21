import { Check, ChevronDown, Plus } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

/**
 * Compact multi-select: a trigger summarising the selection, opening a searchable
 * checklist. Stays one line tall however many options exist.
 */
export function MultiSelect({
  label,
  options,
  selected,
  onChange,
  allowCustom = false,
  placeholder = "None selected",
}: {
  label: string;
  options: string[];
  selected: string[];
  onChange: (next: string[]) => void;
  allowCustom?: boolean;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  // Selection when the panel opened: those stay on top, and the order doesn't change
  // while you tick boxes (re-sorting on every click moved items under the pointer).
  const [pinned, setPinned] = useState<string[]>(selected);
  const ref = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const all = [...new Set([...pinned, ...options, ...selected])];
  const needle = q.trim().toLowerCase();
  const shown = all
    .filter((o) => o.toLowerCase().includes(needle))
    .sort((a, b) => Number(pinned.includes(b)) - Number(pinned.includes(a)));
  const canAdd = allowCustom && needle !== "" && !all.some((o) => o.toLowerCase() === needle);
  const flip = (o: string) => onChange(selected.includes(o) ? selected.filter((x) => x !== o) : [...selected, o]);

  const summary =
    selected.length === 0
      ? placeholder
      : selected.length <= 3
        ? selected.join(", ")
        : `${selected.slice(0, 2).join(", ")} and ${selected.length - 2} more`;

  return (
    <div className="ms" ref={ref} onKeyDown={(e) => e.key === "Escape" && setOpen(false)}>
      <button
        type="button"
        className="ms-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`${label}: ${selected.length === 0 ? "none" : selected.join(", ")}`}
        onClick={() => {
          if (!open) setPinned(selected);
          setOpen((v) => !v);
        }}
      >
        <span className={selected.length === 0 ? "ms-summary empty" : "ms-summary"}>{summary}</span>
        {selected.length > 0 && <span className="ms-count">{selected.length}</span>}
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <div className="ms-panel" id={panelId}>
          <input
            ref={search}
            className="ms-search mono"
            placeholder={allowCustom ? "Search or type a field…" : "Search…"}
            aria-label={`Search ${label.toLowerCase()}`}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canAdd) {
                e.preventDefault();
                onChange([...selected, q.trim()]);
                setQ("");
              }
            }}
          />
          <ul className="ms-list" role="listbox" aria-multiselectable="true" aria-label={label}>
            {shown.map((o) => {
              const on = selected.includes(o);
              return (
                <li key={o} role="option" aria-selected={on}>
                  <button type="button" className={on ? "ms-opt on" : "ms-opt"} onClick={() => flip(o)}>
                    <span className="ms-box" aria-hidden="true">
                      {on && <Check size={12} strokeWidth={2.5} />}
                    </span>
                    <span className="mono">{o}</span>
                  </button>
                </li>
              );
            })}
            {canAdd && (
              <li>
                <button
                  type="button"
                  className="ms-opt"
                  onClick={() => {
                    onChange([...selected, q.trim()]);
                    setQ("");
                  }}
                >
                  <Plus size={12} aria-hidden="true" />
                  <span>
                    Add <span className="mono">{q.trim()}</span>
                  </span>
                </button>
              </li>
            )}
            {shown.length === 0 && !canAdd && <li className="ms-none">No matches.</li>}
          </ul>
          <div className="ms-foot">
            <span>{selected.length} selected</span>
            {selected.length > 0 && (
              <button type="button" className="link-btn" onClick={() => onChange([])}>
                Clear
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
