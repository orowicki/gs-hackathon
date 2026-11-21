import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import pg from "pg";
import type { Alert } from "@alerting/shared";
import { createServer, type Deps } from "../src/server.js";
import { createMemoryAlertStores, createPgAlertStores, type AlertStores } from "../src/routes/alerts/store.js";

const root = new URL("../../../", import.meta.url);
const tpl = JSON.parse(readFileSync(new URL("fixtures/alerts/metric-breach.json", root), "utf8")) as Alert;
const base: Deps = { checkPostgres: async () => true, checkRedis: async () => true };

let server: Server | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  if (server) await new Promise((r) => server?.close(r));
  server = undefined;
});

async function serve(stores: AlertStores): Promise<string> {
  server = createServer({ ...base, alerts: { alerts: stores.alerts, audit: stores.audit, suggestions: stores.suggestions } });
  await new Promise<void>((r) => server!.listen(0, r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

type Summary = {
  open: number;
  bySeverity: Record<string, number>;
  byStatus: Record<string, number>;
};

/** tag identifies this run's alerts (source field), so a shared database does not disturb filtered checks. */
function fixtureAlerts(tag: string): Alert[] {
  // [severity, state, count, lastSeen minute, firstSeen minute]
  const rows: Array<[Alert["severity"], Alert["state"], number, number, number]> = [
    ["info", "open", 5, 1, 9],
    ["critical", "open", 1, 2, 8],
    ["warning", "open", 3, 3, 7],
    ["error", "open", 3, 4, 6],
    ["critical", "acknowledged", 9, 5, 5],
    ["error", "resolved", 2, 6, 4],
    ["info", "open", 1, 7, 3],
    ["warning", "acknowledged", 4, 8, 2],
  ];
  const m = (n: number): string => `2026-10-23T09:${String(n).padStart(2, "0")}:00.000Z`;
  return rows.map(([severity, state, count, last, first], i) => ({
    ...tpl,
    id: `${tag}-${i}`,
    source: tag,
    severity,
    state,
    count,
    lastSeen: m(last),
    firstSeen: m(first),
  }));
}

function suite(name: string, make: () => Promise<{ stores: AlertStores; tag: string; cleanup: () => Promise<void> }>): void {
  describe(name, () => {
    const setup = async () => {
      const ctx = await make();
      const alerts = fixtureAlerts(ctx.tag);
      for (const a of alerts) await ctx.stores.alerts.upsert(a);
      const url = await serve(ctx.stores);
      const f = `filter=${encodeURIComponent(`alert.source = "${ctx.tag}"`)}`;
      const list = async (qs: string): Promise<{ status: number; body: Alert[]; headers: Headers }> => {
        const r = await fetch(`${url}/api/alerts?${f}&limit=200${qs ? "&" + qs : ""}`);
        return { status: r.status, body: (await r.json()) as Alert[], headers: r.headers };
      };
      const summary = async (qs = f): Promise<Summary> => (await (await fetch(`${url}/api/alerts/summary?${qs}`)).json()) as Summary;
      return { ...ctx, alerts, url, f, list, summary };
    };

    it("counts per severity (open only) and per status, narrowed by filter", async () => {
      const t = await setup();
      try {
        expect(await t.summary()).toEqual({
          open: 5,
          bySeverity: { critical: 1, error: 1, warning: 1, info: 2 },
          byStatus: { open: 5, acknowledged: 2, resolved: 1 },
        });
        const none = await t.summary(`filter=${encodeURIComponent('alert.source = "nope-nothing"')}`);
        expect(none).toEqual({
          open: 0,
          bySeverity: { critical: 0, error: 0, warning: 0, info: 0 },
          byStatus: { open: 0, acknowledged: 0, resolved: 0 },
        });
      } finally {
        await t.cleanup();
      }
    });

    it("unfiltered summary is one aggregate that includes this run's alerts", async () => {
      const t = await setup();
      try {
        const all = await t.summary("");
        expect(all.open).toBeGreaterThanOrEqual(5);
        expect(all.open).toBe(all.byStatus.open);
        expect(Object.values(all.bySeverity).reduce((a, b) => a + b, 0)).toBe(all.open);
      } finally {
        await t.cleanup();
      }
    });

    it("summary with a filter equals counts derived from the list", async () => {
      const t = await setup();
      try {
        for (const expr of [`alert.severity >= error`, `alert.status = open AND alert.severity = info`, `alert.count > 2`]) {
          const q = `filter=${encodeURIComponent(`alert.source = "${t.tag}" AND (${expr})`)}`;
          const r = await fetch(`${t.url}/api/alerts?${q}&limit=200`);
          const rows = (await r.json()) as Alert[];
          const want = { open: 0, bySeverity: { critical: 0, error: 0, warning: 0, info: 0 } as Record<string, number>, byStatus: { open: 0, acknowledged: 0, resolved: 0 } as Record<string, number> };
          for (const a of rows) {
            want.byStatus[a.state]!++;
            if (a.state === "open") {
              want.open++;
              want.bySeverity[a.severity]!++;
            }
          }
          expect(await t.summary(q)).toEqual(want);
        }
        // the JSON tree param works too
        const tree = JSON.stringify({ type: "cmp", field: "alert.source", op: "=", value: t.tag });
        const viaTree = await t.summary(`tree=${encodeURIComponent(tree)}`);
        expect(viaTree.byStatus).toEqual({ open: 5, acknowledged: 2, resolved: 1 });
      } finally {
        await t.cleanup();
      }
    });

    it("sorts by each key in both directions", async () => {
      const t = await setup();
      try {
        const id = (i: number): string => `${t.tag}-${i}`;
        const expected: Record<string, string[]> = {
          // asc order of ids (ties broken by id in the same direction as order)
          lastSeen: [0, 1, 2, 3, 4, 5, 6, 7].map(id),
          firstSeen: [7, 6, 5, 4, 3, 2, 1, 0].map(id),
          severity: [0, 6, 2, 7, 3, 5, 1, 4].map(id), // info, info, warning, warning, error, error, critical, critical
          count: [1, 6, 5, 2, 3, 7, 0, 4].map(id), // 1,1,2,3,3,4,5,9
        };
        for (const [sort, asc] of Object.entries(expected)) {
          const a = await t.list(`sort=${sort}&order=asc`);
          expect(a.status).toBe(200);
          expect(a.body.map((x) => x.id), `${sort} asc`).toEqual(asc);
          const d = await t.list(`sort=${sort}&order=desc`);
          expect(d.body.map((x) => x.id), `${sort} desc`).toEqual([...asc].reverse());
        }
        // sort alone defaults to desc; order alone sorts lastSeen
        expect((await t.list("sort=count")).body.map((x) => x.id)).toEqual([...expected.count!].reverse());
        expect((await t.list("order=asc")).body.map((x) => x.id)).toEqual(expected.lastSeen);
      } finally {
        await t.cleanup();
      }
    });

    it("pages a non-default sort with offset", async () => {
      const t = await setup();
      try {
        const full = (await t.list("sort=severity&order=desc")).body.map((x) => x.id);
        const get = async (qs: string) => {
          const r = await fetch(`${t.url}/api/alerts?${t.f}&${qs}`);
          return { body: (await r.json()) as Alert[], next: r.headers.get("x-next-offset") };
        };
        const p1 = await get("sort=severity&order=desc&limit=3&offset=0");
        const p2 = await get("sort=severity&order=desc&limit=3&offset=3");
        const p3 = await get("sort=severity&order=desc&limit=3&offset=6");
        expect([...p1.body, ...p2.body, ...p3.body].map((x) => x.id)).toEqual(full);
        expect(p3.body).toHaveLength(2);
        expect(p1.next).toBe("3");
        expect(p3.next).toBeNull();
        expect(p2.next).toBe("6");
      } finally {
        await t.cleanup();
      }
    });

    it("default order is unchanged and before cursor still pages", async () => {
      const t = await setup();
      try {
        const def = (await t.list("")).body.map((x) => x.id);
        expect(def).toEqual([7, 6, 5, 4, 3, 2, 1, 0].map((i) => `${t.tag}-${i}`));
        expect((await t.list("sort=lastSeen&order=desc")).body.map((x) => x.id)).toEqual(def);
        const r1 = await fetch(`${t.url}/api/alerts?${t.f}&limit=3`);
        const b1 = (await r1.json()) as Alert[];
        const next = r1.headers.get("x-next-before");
        expect(next).toBeTruthy();
        const r2 = await fetch(`${t.url}/api/alerts?${t.f}&limit=3&before=${encodeURIComponent(next!)}`);
        expect([...b1, ...((await r2.json()) as Alert[])].map((x) => x.id)).toEqual(def.slice(0, 6));
        // before + non-default sort / offset is rejected
        for (const extra of ["sort=count", "order=asc"]) {
          const bad = await fetch(`${t.url}/api/alerts?${t.f}&before=${encodeURIComponent(next!)}&${extra}`);
          expect(bad.status).toBe(400);
          expect(typeof ((await bad.json()) as { error: string }).error).toBe("string");
        }
        // offset is ignored with the default sort (backwards compatible), x-next-before is kept
        const ign = await fetch(`${t.url}/api/alerts?${t.f}&limit=3&offset=2`);
        expect((await ign.json() as Alert[]).map((x) => x.id)).toEqual(def.slice(0, 3));
        expect(ign.headers.get("x-next-before")).toBeTruthy();
        expect(ign.headers.get("x-next-offset")).toBeNull();
        const ign2 = await fetch(`${t.url}/api/alerts?${t.f}&before=${encodeURIComponent(next!)}&offset=1`);
        expect(ign2.status).toBe(200);
        // explicit default sort with before is fine
        const ok = await fetch(`${t.url}/api/alerts?${t.f}&sort=lastSeen&order=desc&before=${encodeURIComponent(next!)}`);
        expect(ok.status).toBe(200);
      } finally {
        await t.cleanup();
      }
    });

    it("sorts and pages without a filter (store path)", async () => {
      const t = await setup();
      try {
        const r = await fetch(`${t.url}/api/alerts?sort=severity&order=asc&limit=200`);
        const rows = ((await r.json()) as Alert[]).filter((a) => a.source === t.tag).map((a) => a.id);
        expect(rows).toEqual([0, 6, 2, 7, 3, 5, 1, 4].map((i) => `${t.tag}-${i}`));
        const p = await fetch(`${t.url}/api/alerts?sort=count&order=desc&limit=2&offset=1`);
        expect(p.status).toBe(200);
        expect(p.headers.get("x-next-offset")).toBe("3");
      } finally {
        await t.cleanup();
      }
    });

    it("rejects invalid sort, order, offset and filter with 400 { error }", async () => {
      const t = await setup();
      try {
        const bad = [
          `${t.url}/api/alerts?sort=title`,
          `${t.url}/api/alerts?order=sideways`,
          `${t.url}/api/alerts?sort=count&offset=-1`,
          `${t.url}/api/alerts?sort=count&offset=1.5`,
          `${t.url}/api/alerts?sort=count&offset=abc`,
          `${t.url}/api/alerts/summary?filter=${encodeURIComponent("alert.severity >=")}`,
          `${t.url}/api/alerts/summary?tree=${encodeURIComponent("{nope")}`,
        ];
        for (const u of bad) {
          const r = await fetch(u);
          expect(r.status, u).toBe(400);
          expect(typeof ((await r.json()) as { error: string }).error, u).toBe("string");
        }
        // summary is not swallowed by /api/alerts/{id}
        const s = await fetch(`${t.url}/api/alerts/summary`);
        expect(s.status).toBe(200);
        expect(await s.json()).toHaveProperty("bySeverity");
      } finally {
        await t.cleanup();
      }
    });
  });
}

suite("alerts summary and sort (memory store)", async () => ({
  stores: createMemoryAlertStores(),
  tag: "mem",
  cleanup: async () => {},
}));

describe.skipIf(!process.env.DATABASE_URL)("postgres", () => {
  suite("alerts summary and sort (pg store)", async () => {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const tag = `t101-${Date.now()}`;
    return {
      stores: createPgAlertStores(pool),
      tag,
      cleanup: async () => {
        await pool.query("DELETE FROM alerts WHERE id LIKE $1", [`${tag}%`]);
        await pool.end();
      },
    };
  });
});
