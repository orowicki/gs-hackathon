import type { FilterNode } from "@alerting/filter";

/** Time ranges offered next to the filter bar. Stored in the URL as `range=<id>`; no param = all time. */
export const TIME_RANGES = [
  { id: "1h", label: "Last 1 hour" },
  { id: "24h", label: "Last 24 hours" },
  { id: "7d", label: "Last 7 days" },
  { id: "all", label: "All time" },
] as const;

export type TimeRange = (typeof TIME_RANGES)[number]["id"];

export function parseRange(v: string | null): TimeRange {
  return TIME_RANGES.some((r) => r.id === v) ? (v as TimeRange) : "all";
}

/** Search params with `range` set, or removed for "all". */
export function withRange(params: URLSearchParams, range: TimeRange): URLSearchParams {
  const next = new URLSearchParams(params);
  if (range === "all") next.delete("range");
  else next.set("range", range);
  return next;
}

/** The filter condition a range adds: alerts seen within it (`alert.lastSeen >= now-24h`). Null for "all". */
export function rangeTree(range: TimeRange): FilterNode | null {
  return range === "all" ? null : { type: "cmp", field: "alert.lastSeen", op: ">=", value: `now-${range}` };
}

/** The user's filter AND the range condition. */
export function withRangeTree(tree: FilterNode | null, range: TimeRange): FilterNode | null {
  const r = rangeTree(range);
  if (!r) return tree;
  if (!tree) return r;
  return { type: "and", children: [tree, r] };
}
