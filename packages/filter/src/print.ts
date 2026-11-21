import { NUMBER_RE, type FilterNode, type FilterValue } from "./types.js";

const BARE_RE = /^[^\s()[\],"=!<>\\]+$/;
const RESERVED = new Set(["and", "or", "not", "contains", "in", "matches"]);

export function printValue(v: FilterValue): string {
  if (typeof v === "number") return String(v);
  if (BARE_RE.test(v) && !NUMBER_RE.test(v) && !RESERVED.has(v.toLowerCase())) return v;
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Canonical text for a tree. `null` prints as the empty string. */
export function print(tree: FilterNode | null): string {
  return tree === null ? "" : p(tree);
}

function p(n: FilterNode): string {
  switch (n.type) {
    case "cmp":
      return `${n.field} ${n.op} ${printValue(n.value)}`;
    case "in":
      return `${n.field} in [${n.values.map(printValue).join(", ")}]`;
    case "not":
      return n.child.type === "and" || n.child.type === "or" ? `NOT (${p(n.child)})` : `NOT ${p(n.child)}`;
    case "and":
      // Children that are or / and nodes need parentheses (nested same-type nodes keep their shape).
      return n.children.map((c) => (c.type === "or" || c.type === "and" ? `(${p(c)})` : p(c))).join(" AND ");
    case "or":
      return n.children.map((c) => (c.type === "or" ? `(${p(c)})` : p(c))).join(" OR ");
  }
}
