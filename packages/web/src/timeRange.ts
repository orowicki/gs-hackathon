import { print, tryParse, type FilterNode } from "@alerting/filter";

/**
 * Time ranges offered next to the filter bar. Picking one writes `alert.occurredAt >= now-<range>`
 * into the filter text itself, so the filter bar always shows what is applied and the range is
 * saved, starred and shared like any other part of the filter. "all" removes it.
 */
export const TIME_RANGES = [
  { id: "1h", label: "Last 1 hour" },
  { id: "24h", label: "Last 24 hours" },
  { id: "7d", label: "Last 7 days" },
  { id: "all", label: "All time" },
] as const;

export type TimeRange = (typeof TIME_RANGES)[number]["id"];

export const RANGE_FIELD = "alert.occurredAt";

const RANGE_IDS = new Set<string>(TIME_RANGES.map((r) => r.id).filter((id) => id !== "all"));

/** The condition a range stands for: `alert.occurredAt >= now-24h`. Null for "all". */
export function rangeNode(range: TimeRange): FilterNode | null {
  return range === "all" ? null : { type: "cmp", field: RANGE_FIELD, op: ">=", value: `now-${range}` };
}

/** The range a node stands for, if it is exactly one of the picker's conditions. */
function rangeOfNode(n: FilterNode): TimeRange | null {
  if (n.type !== "cmp" || n.field !== RANGE_FIELD || n.op !== ">=" || typeof n.value !== "string") return null;
  const m = /^now-(\w+)$/i.exec(n.value.trim());
  const id = m?.[1]?.toLowerCase();
  return id && RANGE_IDS.has(id) ? (id as TimeRange) : null;
}

/** Top-level AND parts of a tree (the tree itself when it is not an AND). */
function parts(tree: FilterNode | null): FilterNode[] {
  if (!tree) return [];
  return tree.type === "and" ? tree.children : [tree];
}

function join(nodes: FilterNode[]): FilterNode | null {
  if (nodes.length === 0) return null;
  return nodes.length === 1 ? nodes[0]! : { type: "and", children: nodes };
}

/** The range the filter text currently applies ("all" when none, or when the text doesn't parse). */
export function rangeOf(text: string): TimeRange {
  const r = tryParse(text);
  if (!r.ok) return "all";
  for (const n of parts(r.tree)) {
    const id = rangeOfNode(n);
    if (id) return id;
  }
  return "all";
}

/** The filter text without the picker's time condition (unchanged when the text doesn't parse). */
export function withoutRange(text: string): string {
  const r = tryParse(text);
  if (!r.ok) return text;
  const rest = parts(r.tree).filter((n) => !rangeOfNode(n));
  return rest.length === parts(r.tree).length ? text : print(join(rest));
}

/** The filter text with its time condition replaced by `range` (removed for "all"), ANDed onto the rest. */
export function setRange(text: string, range: TimeRange): string {
  const node = rangeNode(range);
  const r = tryParse(text);
  if (!r.ok) {
    // Leave text the user is still fixing alone; only append, so nothing they typed is lost.
    return node ? `${text} AND ${print(node)}` : text;
  }
  const rest = parts(r.tree).filter((n) => !rangeOfNode(n));
  return print(join(node ? [...rest, node] : rest));
}
