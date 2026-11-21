import { ArrowDownWideNarrow, ChevronDown } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "./Icon";
import "./time-range/time-range.css";

/** Grafana-style dropdown, the twin of TimeRangePicker (same classes, same keyboard handling). */
export function SortPicker<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: readonly { id: T; label: string }[];
  onChange: (v: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const listId = useId();
  const current = options.find((o) => o.id === value) ?? options[0]!;

  useEffect(() => {
    if (!open) return;
    items.current[options.findIndex((o) => o.id === value)]?.focus();
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, value, options]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") return setOpen(false);
    if (!open || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
    e.preventDefault();
    const at = items.current.findIndex((el) => el === document.activeElement);
    items.current[(at + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length]?.focus();
  };

  return (
    <div className={`time-range${value === options[0]!.id ? "" : " active"}`} ref={ref} onKeyDown={onKeyDown}>
      <button
        type="button"
        className="time-range-trigger"
        title="Order of the alert list"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={`Sort: ${current.label}`}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon as={ArrowDownWideNarrow} />
        <span>{current.label}</span>
        <ChevronDown size={14} aria-hidden="true" className={open ? "time-range-chevron open" : "time-range-chevron"} />
      </button>
      {open && (
        <ul className="time-range-panel" id={listId} role="listbox" aria-label="Sort">
          {options.map((o, i) => (
            <li key={o.id} role="option" aria-selected={o.id === value}>
              <button
                type="button"
                ref={(el) => {
                  items.current[i] = el;
                }}
                className={o.id === value ? "time-range-opt selected" : "time-range-opt"}
                onClick={() => {
                  setOpen(false);
                  if (o.id !== value) onChange(o.id);
                }}
              >
                {o.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
