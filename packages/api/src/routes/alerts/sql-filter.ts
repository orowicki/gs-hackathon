import { SEVERITY_ORDER, type FilterNode } from "@alerting/filter";

export interface SqlFilter {
  sql: string;
  params: unknown[];
}

/**
 * Fixed whitelist: filter field -> SQL text expression, mirroring how filter-context.ts builds
 * the `alert.*` context. A missing key and a JSON null both yield SQL NULL, which evaluate.ts
 * also treats alike (undefined or null). Only fields we can reproduce exactly are listed.
 */
const FIELD_SQL: Readonly<Record<string, string>> = {
  "alert.severity": "(data->>'severity')",
  "alert.title": "(data->>'title')",
  "alert.source": "(data->>'source')",
  "alert.environment": "(data->>'environment')",
  "alert.status": "state",
  "alert.schema": "(data->>'schemaId')",
  "alert.ruleId": "(data->>'ruleId')",
  "alert.dedupKey": "(data->>'dedupKey')",
};

/** Severity names in ascending rank order; array_position() gives the rank (1 = info). */
const SEVERITY_LIST = Object.entries(SEVERITY_ORDER)
  .sort((a, b) => a[1] - b[1])
  .map(([k]) => k);

/**
 * Compile a filter tree to a parameterised WHERE fragment (placeholders start at `$startIndex`).
 * Every leaf is a strict boolean (never NULL) so NOT behaves like evaluate.ts.
 * Returns null when any part cannot be reproduced exactly (event paths, matches, time or numeric
 * comparisons, numeric literals, unknown fields); the caller then evaluates in Node.
 */
export function compileFilterToSql(tree: FilterNode, startIndex = 1): SqlFilter | null {
  const params: unknown[] = [];
  const ph = (v: unknown): string => {
    params.push(v);
    return `$${startIndex + params.length - 1}`;
  };
  const colOf = (field: string): string | undefined => (Object.hasOwn(FIELD_SQL, field) ? FIELD_SQL[field] : undefined);

  const go = (n: FilterNode): string | null => {
    switch (n.type) {
      case "and":
      case "or": {
        if (n.children.length === 0) return n.type === "and" ? "TRUE" : "FALSE";
        const parts: string[] = [];
        for (const c of n.children) {
          const s = go(c);
          if (s === null) return null;
          parts.push(s);
        }
        return `(${parts.join(n.type === "and" ? " AND " : " OR ")})`;
      }
      case "not": {
        const s = go(n.child);
        return s === null ? null : `(NOT ${s})`;
      }
      case "in": {
        const col = colOf(n.field);
        if (!col || n.values.some((v) => typeof v !== "string")) return null;
        return `COALESCE(${col} = ANY(${ph(n.values)}::text[]), FALSE)`;
      }
      case "cmp": {
        const col = colOf(n.field);
        if (!col || typeof n.value !== "string") return null;
        switch (n.op) {
          case "=":
            return `COALESCE(${col} = ${ph(n.value)}, FALSE)`;
          case "!=":
            // A missing field satisfies != (evaluate.ts: `op === "!="`).
            return `(${col} IS NULL OR ${col} <> ${ph(n.value)})`;
          case "contains":
            return `COALESCE(position(${ph(n.value)}::text in ${col}) > 0, FALSE)`;
          case ">":
          case ">=":
          case "<":
          case "<=": {
            if (n.field !== "alert.severity") return null;
            const lit = n.value.toLowerCase();
            if (!Object.hasOwn(SEVERITY_ORDER, lit)) return "FALSE";
            const rank = SEVERITY_LIST.indexOf(lit) + 1;
            return `COALESCE(array_position(${ph(SEVERITY_LIST)}::text[], lower(${col})) ${n.op} ${ph(rank)}::int, FALSE)`;
          }
          default:
            return null;
        }
      }
    }
  };

  const sql = go(tree);
  return sql === null ? null : { sql, params };
}
