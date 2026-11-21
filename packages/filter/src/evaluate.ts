import { SEVERITY_FIELD, SEVERITY_ORDER, type EvalContext, type FilterNode, type FilterValue } from "./types.js";

function getPath(root: unknown, path: string): unknown {
  let cur = root;
  for (const seg of path.split(".")) {
    if (cur === null || typeof cur !== "object" || !Object.hasOwn(cur, seg)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function resolve(field: string, ctx: EvalContext): unknown {
  if (field.startsWith("alert.")) return getPath(ctx.alert, field.slice(6));
  return getPath(ctx.event, field);
}

function toNum(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function eq(actual: unknown, lit: FilterValue): boolean {
  if (typeof lit === "number") {
    const n = toNum(actual);
    if (n !== undefined) return n === lit;
  }
  return String(actual) === String(lit);
}

function globToRegExp(glob: string): RegExp {
  let re = "";
  for (const ch of glob) {
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else re += ch.replace(/[.*+?^${}()|[\]\\\-/]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "s");
}

function order(op: string, a: number, b: number): boolean {
  switch (op) {
    case ">":
      return a > b;
    case ">=":
      return a >= b;
    case "<":
      return a < b;
    case "<=":
      return a <= b;
  }
  return false;
}

function cmp(actual: unknown, op: string, lit: FilterValue, field: string): boolean {
  if (actual === undefined || actual === null) return op === "!=";
  switch (op) {
    case "=":
      return eq(actual, lit);
    case "!=":
      return !eq(actual, lit);
    case "contains":
      if (Array.isArray(actual)) return actual.some((x) => x !== null && x !== undefined && eq(x, lit));
      if (typeof actual === "string" || typeof actual === "number") return String(actual).includes(String(lit));
      return false;
    case "matches":
      return globToRegExp(String(lit)).test(String(actual));
    default: {
      if (field === SEVERITY_FIELD) {
        const a = typeof actual === "string" && Object.hasOwn(SEVERITY_ORDER, actual) ? SEVERITY_ORDER[actual] : undefined;
        const b = typeof lit === "string" && Object.hasOwn(SEVERITY_ORDER, lit) ? SEVERITY_ORDER[lit] : undefined;
        return a !== undefined && b !== undefined && order(op, a, b);
      }
      const a = toNum(actual);
      return a !== undefined && typeof lit === "number" && order(op, a, lit);
    }
  }
}

/** Evaluate a tree against an alert and its event. A `null` tree (empty filter) matches everything. */
export function evaluate(tree: FilterNode | null, ctx: EvalContext = {}): boolean {
  if (tree === null) return true;
  switch (tree.type) {
    case "and":
      return tree.children.every((c) => evaluate(c, ctx));
    case "or":
      return tree.children.some((c) => evaluate(c, ctx));
    case "not":
      return !evaluate(tree.child, ctx);
    case "cmp":
      return cmp(resolve(tree.field, ctx), tree.op, tree.value, tree.field);
    case "in": {
      const actual = resolve(tree.field, ctx);
      if (actual === undefined || actual === null) return false;
      return tree.values.some((v) => eq(actual, v));
    }
  }
}
