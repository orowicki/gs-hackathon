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

describe.skipIf(!DATABASE_URL)("open-key locking under concurrency (real postgres)", () => {
  const rid = `lk-${Date.now()}`;
  const pools = [0, 1].map(() => new pg.Pool({ connectionString: DATABASE_URL, max: 4 }));

  it("the same event id raced on a new key is applied once; the other call is a replay", async () => {
    await pools[0]!.query(DDL);
    const [a, b] = pools.map((p) => createPgAlertRepo(p));
    for (let i = 0; i < 10; i++) {
      const alert = mkAlert(`${rid}-same-${i}`, `${rid}-s`, `k${i}`);
      const res = await Promise.all([a!.upsertOpen(alert), b!.upsertOpen(alert)]);
      expect(res.filter((r) => r?.created)).toHaveLength(1);
      expect(res.filter((r) => r === null)).toHaveLength(1);
      expect((await a!.get(alert.id))?.count).toBe(1);
    }
  });

  it("batches taking the same keys in opposite order do not deadlock", async () => {
    const [a, b] = pools.map((p) => createPgAlertRepo(p, { maxInFlight: 1 }));
    const keys = Array.from({ length: 30 }, (_, i) => `k${i}`);
    for (let round = 0; round < 5; round++) {
      const pa = keys.map((k) => a!.upsertOpen(mkAlert(`${rid}-a${round}-${k}`, `${rid}-d`, k)));
      const pb = [...keys].reverse().map((k) => b!.upsertOpen(mkAlert(`${rid}-b${round}-${k}`, `${rid}-d`, k)));
      const settled = await Promise.allSettled([...pa, ...pb]);
      expect(settled.filter((s) => s.status === "rejected")).toEqual([]);
    }
    const r = await pools[0]!.query(
      "SELECT count(*)::int AS n, sum((data->>'count')::int)::int AS c FROM alerts WHERE rule_id = $1",
      [`${rid}-d`],
    );
    expect(r.rows[0]).toEqual({ n: 30, c: 300 });
  });

  afterAll(async () => {
    await pools[0]!.query("DELETE FROM alert_open_keys WHERE rule_id LIKE $1", [`${rid}%`]);
    await pools[0]!.query("DELETE FROM alerts WHERE rule_id LIKE $1", [`${rid}%`]);
    for (const p of pools) await p.end();
  });
});
