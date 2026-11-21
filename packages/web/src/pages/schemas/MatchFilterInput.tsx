import { useEffect, useState } from "react";
import { sendJson } from "../sources/api";

interface ParseError {
  message: string;
  position: number;
}

/** Text input validated via POST /api/filters/parse. Swap for the shared filter input when it exists. */
export function MatchFilterInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [error, setError] = useState<ParseError | null>(null);

  useEffect(() => {
    if (value.trim() === "") {
      setError(null);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      sendJson<{
        tree?: unknown;
        message?: string;
        position?: number;
        error?: string;
      }>("POST", "/api/filters/parse", { text: value }).then(
        (r) => {
          if (!live) return;
          if (r.tree !== undefined) setError(null);
          else
            setError({
              message: r.message ?? r.error ?? "Invalid filter",
              position: r.position ?? 0,
            });
        },
        (e: Error) => live && setError({ message: e.message, position: 0 }),
      );
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [value]);

  return (
    <div className="field">
      <label htmlFor="match-filter">Match filter</label>
      <input
        id="match-filter"
        type="text"
        className="mono"
        spellCheck={false}
        value={value}
        aria-invalid={error ? true : undefined}
        placeholder='for example type = "WORKFLOW_FAILED" (empty matches everything)'
        onChange={(e) => onChange(e.target.value)}
      />
      <span className="hint">
        Only events matching this filter use this schema.
      </span>
      {error && (
        <span className="field-error" role="alert">
          {error.message}
          {error.position > 0 ? ` (at position ${error.position})` : ""}
        </span>
      )}
    </div>
  );
}
