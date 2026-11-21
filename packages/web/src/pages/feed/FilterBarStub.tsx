import { tryParse } from "@alerting/filter";
import { Star } from "lucide-react";
import { useEffect, useRef } from "react";
import { Icon } from "../../components/Icon";

// TEMPORARY stand-in for components/filter-bar (same props). Swap the import in FeedPage.tsx.
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
  const { value, onChange, onApply, starred, onToggleStar, inputRef } = props;
  const parsed = tryParse(value);
  const error = parsed.ok ? null : parsed.error;
  const apply = useRef(onApply);
  apply.current = onApply;

  useEffect(() => {
    if (!tryParse(value).ok) return;
    const t = setTimeout(() => apply.current(value), 250);
    return () => clearTimeout(t);
  }, [value]);

  const isStarred = starred.includes(value.trim());
  return (
    <div className="filter-stub">
      <div className="filter">
        <input
          ref={inputRef}
          type="text"
          aria-label="Filter"
          placeholder="alert.severity = critical"
          spellCheck={false}
          autoComplete="off"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          className="icon-btn"
          aria-label="Star filter"
          aria-pressed={isStarred}
          disabled={value.trim() === "" || error !== null}
          onClick={() => onToggleStar(value.trim())}
        >
          <Icon as={Star} />
        </button>
      </div>
      {error && (
        <p className="filter-stub-error" role="alert">
          {error.message}
        </p>
      )}
    </div>
  );
}
