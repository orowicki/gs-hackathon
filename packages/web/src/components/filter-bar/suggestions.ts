import { COMMON_FIELDS, OPERATORS, suggestContext } from "@alerting/filter";

/** Characters that end a bare word in the filter language. */
const STOP = new Set([" ", "\t", "\n", "\r", "(", ")", "[", "]", ",", '"', "=", "!", "<", ">"]);
const OP_CHARS = new Set(["=", "!", "<", ">"]);
const RESERVED = new Set(["and", "or", "not", "in", "contains", "matches"]);

export type SuggestionKind = "starred" | "field" | "operator" | "value" | "logic";

export interface Suggestion {
  kind: SuggestionKind;
  /** Text shown in the list. */
  label: string;
  /** Short plain-English hint (operators). */
  description?: string;
  /** What replaces the token (or the whole text, for starred). */
  insert: string;
}

export interface TokenRange {
  start: number;
  end: number;
}

export const MAX_SUGGESTIONS = 50;

function clamp(n: number, max: number): number {
  return Math.max(0, Math.min(n, max));
}

/** True when an unescaped `"` opened before `cursor` and is still open. Returns its index, or -1. */
function openQuote(text: string, cursor: number): number {
  let open = -1;
  for (let i = 0; i < cursor; i++) {
    const c = text[i];
    if (open >= 0) {
      if (c === "\\" && (text[i + 1] === '"' || text[i + 1] === "\\")) i++;
      else if (c === '"') open = -1;
    } else if (c === '"') open = i;
  }
  return open;
}

/** The range of the token being typed at `cursor` (empty range when between tokens). */
export function tokenRange(text: string, cursor: number = text.length): TokenRange {
  const at = clamp(cursor, text.length);
  const q = openQuote(text, at);
  if (q >= 0) {
    let end = at;
    while (end < text.length) {
      if (text[end] === "\\" && (text[end + 1] === '"' || text[end + 1] === "\\")) end += 2;
      else if (text[end] === '"') return { start: q, end: end + 1 };
      else end++;
    }
    return { start: q, end: text.length };
  }
  const prev = text[at - 1];
  const isOp = prev !== undefined && OP_CHARS.has(prev);
  let start = at;
  if (isOp) {
    while (start > 0 && OP_CHARS.has(text[start - 1] as string)) start--;
  } else {
    while (start > 0 && !STOP.has(text[start - 1] as string)) start--;
  }
  let end = at;
  if (!isOp) while (end < text.length && !STOP.has(text[end] as string)) end++;
  return { start, end };
}

/** Quote a value only when the language requires it. */
export function quoteValue(value: string): string {
  const bare = value !== "" && ![...value].some((c) => STOP.has(c)) && !RESERVED.has(value.toLowerCase());
  if (bare) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Replace the token at `cursor` with `insert`; returns the new text and caret position. */
export function applyReplacement(
  text: string,
  cursor: number,
  insert: string,
): { text: string; cursor: number } {
  const { start, end } = tokenRange(text, cursor);
  const next = text.slice(0, start) + insert + text.slice(end);
  return { text: next, cursor: start + insert.length };
}

export interface SuggestInput {
  text: string;
  cursor?: number;
  fields: readonly string[];
  valuesFor(field: string): readonly string[];
  starred: readonly string[];
}

const byLabel = (a: Suggestion, b: Suggestion) => a.label.localeCompare(b.label);

function dedupe(items: Suggestion[]): Suggestion[] {
  const seen = new Set<string>();
  return items.filter((s) => (seen.has(s.insert) ? false : (seen.add(s.insert), true)));
}

/** Starred filters first (alphabetical, matching anywhere), then token completions (alphabetical). */
export function computeSuggestions(input: SuggestInput): Suggestion[] {
  const { text, fields, valuesFor, starred } = input;
  const cursor = clamp(input.cursor ?? text.length, text.length);
  const needle = text.trim().toLowerCase();

  const stars: Suggestion[] = [...new Set(starred)]
    .filter((s) => s.trim() !== "" && s !== text.trim() && s.toLowerCase().includes(needle))
    .map((s) => ({ kind: "starred" as const, label: s, insert: s }))
    .sort(byLabel);

  const ctx = suggestContext(text, cursor);
  const prefix = ctx.prefix.toLowerCase();
  const range = tokenRange(text, cursor);
  const quoted = text[range.start] === '"';
  let items: Suggestion[] = [];

  if (ctx.expect === "field") {
    items = [...new Set([...COMMON_FIELDS, ...fields])].map((f) => ({
      kind: "field" as const,
      label: f,
      insert: `${f} `,
    }));
  } else if (ctx.expect === "operator") {
    items = OPERATORS.map((o) => ({
      kind: "operator" as const,
      label: o.symbol,
      description: o.description,
      insert: `${o.symbol} `,
    }));
  } else if (ctx.expect === "value") {
    items = (ctx.field ? valuesFor(ctx.field) : []).map((v) => ({
      kind: "value" as const,
      label: v,
      insert: `${quoteValue(v)} `,
    }));
  } else {
    items = ["AND", "OR", ")"].map((k) => ({
      kind: "logic" as const,
      label: k,
      insert: k === ")" ? ")" : `${k} `,
    }));
  }

  const tokens = items
    .filter((s) => s.label.toLowerCase().startsWith(prefix))
    // Nothing to complete when the token is already exactly this suggestion.
    .filter((s) => !(prefix !== "" && s.label.toLowerCase() === prefix && !quoted && s.kind === "logic"))
    .sort(byLabel);
  return dedupe([...stars, ...tokens]).slice(0, MAX_SUGGESTIONS);
}

/** Plain-English error with a column, e.g. `Expected a value after "=" at column 17`. */
export function formatError(error: { message: string; position: number }): string {
  const { message, position } = error;
  const swapped = message.replace(/\bposition (\d+)/g, "column $1");
  if (/\bcolumn \d+/.test(swapped)) return swapped;
  return `${message.replace(/[.\s]+$/, "")} at column ${position}`;
}
