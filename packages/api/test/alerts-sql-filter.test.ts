import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import pg from "pg";
import { evaluate, parse, type FilterNode } from "@alerting/filter";
import type { Alert } from "@alerting/shared";
import { compileFilterToSql } from "../src/routes/alerts/sql-filter.js";
import { alertContext } from "../src/routes/alerts/filter-context.js";
import { addToSummary, createPgAlertStores, emptySummary } from "../src/routes/alerts/store.js";

const tree = (src: string): FilterNode => {
  const r = parse(src);
  if (!r) throw new Error(`bad filter ${src}`);
  return r;
};
const c = (src: string, start?: number) => compileFilterToSql(tree(src), start);

describe("compileFilterToSql", () => {
  it("compiles = and != with params, != matching a missing field", () => {
    expect(c('alert.title = "x"')).toEqual({ sql: "COALESCE((data->>'title') = $1, FALSE)", params: ["x"] });
    expect(c('alert.title != "x"')).toEqual({
      sql: "((data->>'title') IS NULL OR (data->>'title') <> $1)",
      params: ["x"],
    });
  });

  it("maps alert.status to the state column and alert.schema to schemaId", () => {
    expect(c("alert.status = open")?.sql).toBe("COALESCE(state = $1, FALSE)");
    expect(c("alert.schema = foo")?.sql).toContain("data->>'schemaId'");
  });

  it("compiles contains and in", () => {
    expect(c('alert.title contains "disk"')).toEqual({
      sql: "COALESCE(position($1::text in (data->>'title')) > 0, FALSE)",
      params: ["disk"],
    });
    expect(c("alert.source in [a, b]")).toEqual({
      sql: "COALESCE((data->>'source') = ANY($1::text[]), FALSE)",
      params: [["a", "b"]],
    });
  });

  it("uses severity ordering for each ordered operator", () => {
    for (const op of [">", ">=", "<", "<="]) {
      const r = c(`alert.severity ${op} error`);
      expect(r?.sql).toContain(`array_position($1::text[], lower((data->>'severity'))) ${op} $2::int`);
      expect(r?.params).toEqual([["info", "warning", "error", "critical"], 3]);
    }
    expect(c("alert.severity >= Critical")?.params[1]).toBe(4);
    expect(c("alert.severity > bogus")?.sql).toBe("FALSE");
  });

  it("combines AND/OR/NOT and numbers params from startIndex", () => {
    const r = c("alert.status = open AND (alert.source = a OR NOT alert.severity < error)", 5);
    expect(r?.sql).toBe(
      "(COALESCE(state = $5, FALSE) AND (COALESCE((data->>'source') = $6, FALSE) OR (NOT COALESCE(array_position($7::text[], lower((data->>'severity'))) < $8::int, FALSE))))",
    );
    expect(r?.params).toHaveLength(4);
  });

  it("returns null for unsupported trees", () => {
    expect(c("host = web1")).toBeNull();
    expect(c('alert.title matches "a*"')).toBeNull();
    expect(c("alert.count > 2")).toBeNull();
    expect(c("alert.lastSeen > now-24h")).toBeNull();
    expect(c("alert.status = open AND host = x")).toBeNull();
    expect(c("alert.source = 5")).toBeNull();
    expect(c("alert.title > a")).toBeNull();
  });

  it("never concatenates values into the SQL", () => {
    expect(c(`alert.title = "x'; DROP TABLE alerts; --"`)?.sql).not.toContain("DROP");
  });
});

describe.skipIf(!process.env.DATABASE_URL)("sql path equals node path (postgres)", () => {
  it("matches evaluate() on varied alerts", async () => {
    const root = new URL("../../../", import.meta.url);
    const tpl = JSON.parse(readFileSync(new URL("fixtures/alerts/metric-breach.json", root), "utf8")) as Alert;
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const tag = `sqlf-${Date.now()}`;
    const stores = createPgAlertStores(pool);
    const sevs = ["info", "warning", "error", "critical"] as const;
    const states = ["open", "acknowledged", "resolved"] as const;
    const alerts: Alert[] = [];
    for (let i = 0; i < 24; i++) {
      const a: Alert = { ...tpl, id: `${tag}-${i}`, severity: sevs[i % 4]!, state: states[i % 3]!, title: `T${i % 5} disk`, dedupKey: `${tag}-${i}` };
      (a as { source: string }).source = tag;
      if (i % 4 === 0) delete (a as { environment?: string }).environment;
      if (i % 5 === 0) (a as { schemaId?: string | null }).schemaId = null;
      alerts.push(a);
      await stores.alerts.upsert(a);
    }
    try {
      const exprs = [
        "alert.severity >= error",
        "alert.severity < warning",
        "alert.severity != info",
        "NOT alert.severity = info",
        "alert.environment != prod",
        "NOT alert.environment = prod",
        "alert.schema = whatever",
        "alert.schema != whatever",
        "alert.status in [open, resolved] AND alert.severity > info",
        'alert.title contains "T1"',
        "alert.status = open OR alert.severity = critical",
        "NOT (alert.status = open AND alert.severity <= warning)",
      ];
      for (const e of exprs) {
        const full = tree(`alert.source = "${tag}" AND (${e})`);
        const sql = compileFilterToSql(full);
        expect(sql, e).not.toBeNull();
        const got = await stores.alerts.summaryWhere!(sql!);
        const want = emptySummary();
        for (const a of alerts) if (evaluate(full, alertContext(a))) addToSummary(want, a);
        expect(got, e).toEqual(want);
      }
    } finally {
      await pool.query("DELETE FROM alerts WHERE id LIKE $1", [`${tag}%`]);
      await pool.end();
    }
  });
});
