// Mirrors packages/filter/src/types.ts (contract: docs/autopilot/interfaces/filter.md).
// Duplicated on purpose so shared has no dependency on @alerting/filter.

/** Comparison operators that take a single value (`in` is its own node). */
export const COMPARISON_OPS = ["=", "!=", ">", ">=", "<", "<=", "contains", "matches"] as const;
export type CmpOp = (typeof COMPARISON_OPS)[number];
export type ComparisonOp = CmpOp;

export type FilterValue = string | number;

/**
 * The parsed JSON tree of a filter expression. Field is `alert.<commonField>`
 * (also `alert.schema`) or a raw event path such as `payload.notional`.
 */
export type FilterNode =
  | { type: "and"; children: FilterNode[] }
  | { type: "or"; children: FilterNode[] }
  | { type: "not"; child: FilterNode }
  | { type: "cmp"; field: string; op: CmpOp; value: FilterValue }
  | { type: "in"; field: string; values: FilterValue[] };

/** A filter is stored and accepted either as text or as the JSON tree. */
export type Filter = string | FilterNode;

export interface FilterParseError {
  message: string;
  /** 1-based column into the text. */
  position: number;
}
