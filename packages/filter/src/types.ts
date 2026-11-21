/** Comparison operators that take a single value. */
export type CmpOp = "=" | "!=" | ">" | ">=" | "<" | "<=" | "contains" | "matches";

export type FilterValue = string | number;

/** The filter tree. Plain JSON, safe to store and send over the wire. */
export type FilterNode =
  | { type: "and"; children: FilterNode[] }
  | { type: "or"; children: FilterNode[] }
  | { type: "not"; child: FilterNode }
  | { type: "cmp"; field: string; op: CmpOp; value: FilterValue }
  | { type: "in"; field: string; values: FilterValue[] };

/** What a filter is evaluated against. `alert.*` fields read `alert`, everything else reads `event`. */
export interface EvalContext {
  alert?: Record<string, unknown>;
  event?: unknown;
  /** Current time in epoch ms for relative dates (`now-24h`); defaults to Date.now(). */
  now?: number;
}

export const COMMON_FIELDS = [
  "alert.severity",
  "alert.title",
  "alert.source",
  "alert.environment",
  "alert.dedupKey",
  "alert.status",
  "alert.occurredAt",
  "alert.lastSeen",
  "alert.firstSeen",
  "alert.schema",
] as const;

export const KEYWORDS = ["AND", "OR", "NOT"] as const;

export interface OperatorInfo {
  symbol: string;
  description: string;
}

export const OPERATORS: readonly OperatorInfo[] = [
  { symbol: "=", description: "is equal to" },
  { symbol: "!=", description: "is not equal to" },
  { symbol: ">", description: "is greater than" },
  { symbol: ">=", description: "is greater than or equal to" },
  { symbol: "<", description: "is less than" },
  { symbol: "<=", description: "is less than or equal to" },
  { symbol: "contains", description: "contains the text (or list item)" },
  { symbol: "in", description: "is one of a list, e.g. in [a, b]" },
  { symbol: "matches", description: "matches a pattern, * = any text, ? = one character" },
];

/** The one field whose values are ordered by rank for >, >=, <, <=. */
export const SEVERITY_FIELD = "alert.severity";

export const SEVERITY_ORDER: Readonly<Record<string, number>> = {
  critical: 4,
  error: 3,
  warning: 2,
  info: 1,
};

/** Valid dotted field path: letters, digits, `_`, `-`, with dots between segments. */
export const FIELD_RE = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;

export const NUMBER_RE = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;

export const CMP_OPS: readonly CmpOp[] = ["=", "!=", ">", ">=", "<", "<=", "contains", "matches"];

export function isValidField(f: unknown): f is string {
  return typeof f === "string" && FIELD_RE.test(f) && !["and", "or", "not"].includes(f.toLowerCase());
}
