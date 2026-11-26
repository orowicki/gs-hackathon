import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import type { Alert } from "@alerting/shared";
import { createPgAlertRepo } from "../src/index.js";

const DATABASE_URL = process.env.DATABASE_URL;

const DDL =
  "CREATE TABLE IF NOT EXISTS alerts (id text PRIMARY KEY, rule_id text NOT NULL, dedup_key text NOT NULL, state text NOT NULL, last_seen timestamptz NOT NULL, data jsonb NOT NULL)";

const mkAlert = (id: string, ruleId: string, dedupKey: string, lastSeen = "2026-01-01T00:00:00.000Z"): Alert =>
  ({
    id,
    ruleId,
    eventId: id,
    schemaId: "s",
    dedupKey,
    state: "open",
    status: "open",
    severity: "info",
    title: id,
    source: "src",
    environment: "",
    count: 1,
    firstSeen: lastSeen,
    lastSeen,
    fields: [],
    common: {},
  }) as unknown as Alert;

describe.skipIf(!DATABASE_URL)("engine open-key mapping leaves other alert writers alone (real postgres)", () => {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });
  const rid = `ok-${Date.now()}`;
  const rawInsert = (a: Alert) =>
    pool.query("INSERT INTO alerts (id, rule_id, dedup_key, state, last_seen, data) VALUES ($1,$2,$3,$4,$5,$6)", [
      a.id,
      a.ruleId,
      a.dedupKey,
      a.state,
      a.lastSeen,
      JSON.stringify(a),
    ]);
  const openCount = async (ruleId: string) =>
    (await pool.query("SELECT count(*)::int AS n FROM alerts WHERE rule_id = $1 AND state <> 'resolved'", [ruleId])).rows[0]
      .n as number;

  it("other writers may insert several open alerts with the same key, before and after the engine", async () => {
    await pool.query(DDL);
    const repo = createPgAlertRepo(pool);
    const rule = `${rid}-a`;
    await rawInsert(mkAlert(`${rule}-x1`, rule, "k"));
    await rawInsert(mkAlert(`${rule}-x2`, rule, "k"));
    const first = await repo.upsertOpen(mkAlert(`${rule}-e1`, rule, "k"));
    expect(first?.created).toBe(true);
    await rawInsert(mkAlert(`${rule}-x3`, rule, "k"));
    const second = await repo.upsertOpen(mkAlert(`${rule}-e2`, rule, "k"));
    expect(second?.created).toBe(false);
    expect(second?.alert.id).toBe(`${rule}-e1`);
    expect(second?.alert.count).toBe(2);
    expect(await openCount(rule)).toBe(4);
  });

  it("an alert resolved or deleted by someone else no longer takes bumps: the next event opens a new one", async () => {
    const repo = createPgAlertRepo(pool);
    const rule = `${rid}-b`;
    expect((await repo.upsertOpen(mkAlert(`${rule}-e1`, rule, "k")))?.created).toBe(true);
    await pool.query("UPDATE alerts SET state = 'resolved' WHERE id = $1", [`${rule}-e1`]);
    const next = await repo.upsertOpen(mkAlert(`${rule}-e2`, rule, "k"));
    expect(next).toMatchObject({ created: true, alert: { id: `${rule}-e2`, count: 1 } });
    await pool.query("DELETE FROM alerts WHERE id = $1", [`${rule}-e2`]);
    const third = await repo.upsertOpen(mkAlert(`${rule}-e3`, rule, "k"));
    expect(third).toMatchObject({ created: true, alert: { id: `${rule}-e3`, count: 1 } });
    expect((await repo.upsertOpen(mkAlert(`${rule}-e4`, rule, "k")))?.alert).toMatchObject({ id: `${rule}-e3`, count: 2 });
  });

  it("resolveOpen resolves the mapped alert only and frees the key", async () => {
    const repo = createPgAlertRepo(pool);
    const rule = `${rid}-c`;
    await repo.upsertOpen(mkAlert(`${rule}-e1`, rule, "k"));
    await rawInsert(mkAlert(`${rule}-x1`, rule, "k"));
    const resolved = await repo.resolveOpen(rule, "k", "2026-01-02T00:00:00.000Z", {} as Alert["common"]);
    expect(resolved).toMatchObject({ id: `${rule}-e1`, state: "resolved" });
    expect(await repo.resolveOpen(rule, "k", "2026-01-02T00:00:00.000Z", {} as Alert["common"])).toBeNull();
    expect((await repo.get(`${rule}-x1`))?.state).toBe("open");
    expect((await repo.upsertOpen(mkAlert(`${rule}-e2`, rule, "k")))?.created).toBe(true);
  });

  it("concurrent creators on a new key from separate pools end with one alert counting every event", async () => {
    const rule = `${rid}-d`;
    const pools = [0, 1, 2].map(() => new pg.Pool({ connectionString: DATABASE_URL, max: 4 }));
    try {
      const repos = pools.map((p) => createPgAlertRepo(p));
      const n = 60;
      const res = await Promise.all(
        Array.from({ length: n }, (_, i) => repos[i % repos.length]!.upsertOpen(mkAlert(`${rule}-e${i}`, rule, "k"))),
      );
      expect(res.filter((r) => r?.created)).toHaveLength(1);
      expect(await openCount(rule)).toBe(1);
      const r = await pool.query("SELECT (data->>'count')::int AS c FROM alerts WHERE rule_id = $1", [rule]);
      expect(r.rows[0].c).toBe(n);
    } finally {
      for (const p of pools) await p.end();
    }
  });

  afterAll(async () => {
    await pool.query("DELETE FROM alert_open_keys WHERE rule_id LIKE $1", [`${rid}%`]);
    await pool.query("DELETE FROM alerts WHERE rule_id LIKE $1", [`${rid}%`]);
    await pool.end();
  });
});
