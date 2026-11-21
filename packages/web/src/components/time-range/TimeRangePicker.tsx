import { ChevronDown, Clock } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "../Icon";
import { TIME_RANGES, type TimeRange } from "../../timeRange";
import "./time-range.css";

/**
 * Grafana-style time range picker. The list always opens downwards, under the button
 * (a native <select> lets the OS open it upwards). Choosing a range calls onChange; the
 * feed writes it into the filter text as `alert.occurredAt >= now-<range>`.
 */
export function TimeRangePicker({ value, onChange }: { value: TimeRange; onChange: (r: TimeRange) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const options = useRef<(HTMLButtonElement | null)[]>([]);
  const listId = useId();
  const current = TIME_RANGES.find((r) => r.id === value) ?? TIME_RANGES[TIME_RANGES.length - 1]!;

  useEffect(() => {
    if (!open) return;
    options.current[TIME_RANGES.findIndex((r) => r.id === value)]?.focus();
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, value]);

  const choose = (r: TimeRange) => {
    setOpen(false);
    if (r !== value) onChange(r);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      setOpen(false);
      return;
    }
    if (!open || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
    e.preventDefault();
    const at = options.current.findIndex((el) => el === document.activeElement);
    const next = (at + (e.key === "ArrowDown" ? 1 : -1) + TIME_RANGES.length) % TIME_RANGES.length;
    options.current[next]?.focus();
  };

  return (
    <div className={`time-range${value === "all" ? "" : " active"}`} ref={ref} onKeyDown={onKeyDown}>
      <button
        type="button"
        className="time-range-trigger"
        title="Show alerts that occurred in this time range"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={`Time range: ${current.label}`}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon as={Clock} />
        <span>{current.label}</span>
        <ChevronDown size={14} aria-hidden="true" className={open ? "time-range-chevron open" : "time-range-chevron"} />
      </button>
      {open && (
        <ul className="time-range-panel" id={listId} role="listbox" aria-label="Time range">
          {TIME_RANGES.map((r, i) => (
            <li key={r.id} role="option" aria-selected={r.id === value}>
              <button
                type="button"
                ref={(el) => {
                  options.current[i] = el;
                }}
                className={r.id === value ? "time-range-opt selected" : "time-range-opt"}
                onClick={() => choose(r.id)}
              >
                {r.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
