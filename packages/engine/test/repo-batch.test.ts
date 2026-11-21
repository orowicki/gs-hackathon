import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import type { Alert, Severity } from "@alerting/shared";
import { createPgAlertRepo } from "../src/index.js";

const DATABASE_URL = process.env.DATABASE_URL;

const DDL = [
  "CREATE TABLE IF NOT EXISTS alerts (id text PRIMARY KEY, rule_id text NOT NULL, dedup_key text NOT NULL, state text NOT NULL, last_seen timestamptz NOT NULL, data jsonb NOT NULL)",
];

const mkAlert = (id: string, ruleId: string, dedupKey: string, severity: Severity = "info", lastSeen = "2026-01-01T00:00:00.000Z"): Alert =>
  ({
    id,
    ruleId,
    eventId: id,
    schemaId: "s",
    dedupKey,
    state: "open",
    status: "open",
    severity,
    title: `t ${id} "quoted" \\ back`,
    source: "src",
    environment: "",
    count: 1,
    firstSeen: lastSeen,
    lastSeen,
    fields: [{ label: "a", value: "b,c{d}" }],
    common: { k: dedupKey, nested: { x: [1, "y"] } },
  }) as unknown as Alert;

describe.skipIf(!DATABASE_URL)("pg repo batched upsertOpen (real postgres)", () => {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });
  let upserts = 0;
  const counting = {
    query: (q: string, v?: unknown[]) => {
      if (q.includes("INSERT INTO alerts")) upserts++;
      return pool.query(q, v);
    },
  };
  const rid = `rb-${Date.now()}`;

  it("coalesces concurrent upserts of distinct keys into few statements with per-call results", async () => {
    await pool.query(DDL[0]!);
    const repo = createPgAlertRepo(counting as never);
    await repo.get("warm-up");
    const n = 300;
    upserts = 0;
    const res = await Promise.all(Array.from({ length: n }, (_, i) => repo.upsertOpen(mkAlert(`${rid}-a${i}`, `${rid}-a`, `k${i}`))));
    expect(upserts).toBeLessThan(n / 5);
    res.forEach((r, i) => {
      expect(r?.created).toBe(true);
      expect(r?.raised).toBe(false);
      expect(r?.alert.id).toBe(`${rid}-a${i}`);
      expect(r?.alert.title).toBe(`t ${rid}-a${i} "quoted" \\ back`);
      expect(r?.alert.common).toEqual({ k: `k${i}`, nested: { x: [1, "y"] } });
    });
  });

  it("concurrent upserts of one key count exactly, create once and report each raise", async () => {
    const repo = createPgAlertRepo(pool);
    const sev: Severity[] = ["info", "info", "error", "warning", "critical", "info"];
    const res = await Promise.all(sev.map((s, i) => repo.upsertOpen(mkAlert(`${rid}-b${i}`, `${rid}-b`, "same", s))));
    expect(res.filter((r) => r?.created)).toHaveLength(1);
    expect(res[0]?.created).toBe(true);
    // calls on one key are applied in call order
    expect(res.map((r) => r?.alert.count)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(res.map((r) => r?.raised)).toEqual([false, false, true, false, true, false]);
    const open = await pool.query("SELECT count(*)::int AS n FROM alerts WHERE rule_id = $1 AND state <> 'resolved'", [`${rid}-b`]);
    expect(open.rows[0].n).toBe(1);
  });

  it("a replayed id returns null without bumping, also inside a batch", async () => {
    const repo = createPgAlertRepo(pool);
    const first = await repo.upsertOpen(mkAlert(`${rid}-c0`, `${rid}-c`, "k"));
    expect(first?.created).toBe(true);
    const [replay, other] = await Promise.all([
      repo.upsertOpen(mkAlert(`${rid}-c0`, `${rid}-c`, "k")),
      repo.upsertOpen(mkAlert(`${rid}-c1`, `${rid}-c`, "k2")),
    ]);
    expect(replay).toBeNull();
    expect(other?.created).toBe(true);
    expect((await repo.get(`${rid}-c0`))?.count).toBe(1);
  });

  it("one bad item fails only its own call", async () => {
    const repo = createPgAlertRepo(pool);
    const calls = [
      repo.upsertOpen(mkAlert(`${rid}-d0`, `${rid}-d`, "k0")),
      repo.upsertOpen(mkAlert(`${rid}-d1`, `${rid}-d`, "k1", "info", "not a timestamp")),
      repo.upsertOpen(mkAlert(`${rid}-d2`, `${rid}-d`, "k2")),
    ];
    const settled = await Promise.allSettled(calls);
    expect(settled.map((s) => s.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
    expect((await repo.get(`${rid}-d0`))?.count).toBe(1);
    expect(await repo.get(`${rid}-d1`)).toBeNull();
  });

  afterAll(async () => {
    await pool.query("DELETE FROM alerts WHERE rule_id LIKE $1", [`${rid}%`]);
    await pool.end();
  });
});
