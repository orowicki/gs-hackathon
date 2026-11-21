export const COMPARISON_OPS = [
  "=",
  "!=",
  ">",
  ">=",
  "<",
  "<=",
  "contains",
  "in",
  "matches",
] as const;
export type ComparisonOp = (typeof COMPARISON_OPS)[number];

/** Value is a scalar, or a list for `in`. `matches` takes a glob string. */
export type FilterValue = string | number | boolean | null | Array<string | number | boolean>;

/**
 * Field is `alert.<commonField>` (also `alert.schema`) or a raw event path
 * such as `payload.notional` or `error.code`.
 */
export interface FilterComparison {
  type: "comparison";
  field: string;
  op: ComparisonOp;
  value: FilterValue;
}
export interface FilterAnd {
  type: "and";
  children: FilterNode[];
}
export interface FilterOr {
  type: "or";
  children: FilterNode[];
}
export interface FilterNot {
  type: "not";
  child: FilterNode;
}
/** The parsed JSON tree of a filter expression. */
export type FilterNode = FilterComparison | FilterAnd | FilterOr | FilterNot;

/** A filter is stored and accepted either as text or as the JSON tree. */
export type Filter = string | FilterNode;

export interface FilterParseError {
  message: string;
  /** 0-based character offset into the text. */
  position: number;
}
