import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { Redis } from "ioredis";
import { createConfigStore, migrate, type ConfigStore } from "@alerting/config";
import { compileRule, createDedupHooks, createPgAlertRepo, createStaticDirectory, processEvent } from "@alerting/engine";
import { migrateRunbooks } from "@alerting/runbooks";
import { STREAM_ALERTS, type AlertEvent, type Event, type Rule } from "@alerting/shared";
import { startRunbookWorkerProcess } from "../../packages/api/src/runbook-worker-process.js";

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;
const here = new URL("./", import.meta.url);
const run = randomUUID().slice(0, 8);
const group = `it-rbstart-${run}`;
const ruleId = `it-rule-rbstart-${run}`;
const runbookId = `it-rb-start-${run}`;
const kind = `IT_RB_START_${run}`;

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 100));
  }
}

// Starts two workers the way packages/api/src/runbook-worker.ts does (same exported function, same group).
describe.skipIf(!DATABASE_URL || !REDIS_URL)("runbook worker process (two instances, one consumer group)", () => {
  let pool: pg.Pool;
  let redis: Redis;
  let store: ConfigStore;
  const workers: Array<{ close(): Promise<void> }> = [];
  const errors: unknown[] = [];
  const alertIds: string[] = [];
  const eventIds: string[] = [];
  const streamIds: string[] = [];

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    redis = new Redis(REDIS_URL!);
    await migrate(pool);
    await migrateRunbooks(pool);
    await pool.query(readFileSync(new URL("../../packages/ingest/migrations/ingest_001_events.sql", here), "utf8"));
    store = createConfigStore({ pool, redis: redis.duplicate() });
    await store.upsert("runbook", {
      id: runbookId,
      name: runbookId,
      type: "automation",
      matches: `type = ${kind}`,
      steps: [{ name: "Short wait", action: "wait", duration: "1s", approval: "none" }],
    } as never);
    // Group at "$" first, so only this test's alert is read.
    await redis.xgroup("CREATE", STREAM_ALERTS, group, "$", "MKSTREAM").catch((e: unknown) => {
      if (!String(e).includes("BUSYGROUP")) throw e;
    });
  });

  afterAll(async () => {
    await Promise.allSettled(workers.map((w) => w.close()));
    await store?.delete("runbook", runbookId).catch(() => undefined);
    await store?.close().catch(() => undefined);
    await redis?.xgroup("DESTROY", STREAM_ALERTS, group).catch(() => undefined);
    if (streamIds.length > 0) await redis?.xdel(STREAM_ALERTS, ...streamIds).catch(() => undefined);
    if (pool) {
      await pool.query("DELETE FROM alert_audit WHERE alert_id = ANY($1)", [alertIds]).catch(() => undefined);
      await pool.query("DELETE FROM audit_log WHERE alert_id = ANY($1)", [alertIds]).catch(() => undefined);
      await pool.query("DELETE FROM runbook_runs WHERE alert_id = ANY($1)", [alertIds]).catch(() => undefined);
      await pool.query("DELETE FROM alerts WHERE id = ANY($1)", [alertIds]).catch(() => undefined);
      await pool.query("DELETE FROM events WHERE id = ANY($1)", [eventIds]).catch(() => undefined);
    }
    const keys = await redis?.keys(`*${ruleId}*`).catch(() => [] as string[]);
    if (keys?.length) await redis.del(...keys);
    await pool?.end();
    redis?.disconnect();
  });

  it("starts the matching runbook exactly once for a created alert", async () => {
    for (const n of ["a", "b"]) {
      workers.push(
        await startRunbookWorkerProcess({
          redisUrl: REDIS_URL!,
          databaseUrl: DATABASE_URL!,
          group,
          consumer: `it-${run}-${n}`,
          onError: (e) => errors.push(e),
        }),
      );
    }

    const parsed = { type: kind } as Event["parsed"];
    const event: Event = {
      id: `it-evt-rbstart-${run}`,
      sourceId: `it-src-${run}`,
      receivedAt: "2026-10-23T09:14:02.000Z",
      raw: parsed,
      parsed,
      schemaId: null,
      common: { severity: "error", title: `runbook worker start ${run}` },
    };
    await pool.query(
      "INSERT INTO events (id, source_id, received_at, raw, parsed, schema_id, common) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [event.id, event.sourceId, event.receivedAt, JSON.stringify(event.raw), JSON.stringify(event.parsed), null, JSON.stringify(event.common)],
    );
    eventIds.push(event.id);
    const rule: Rule = {
      id: ruleId,
      name: ruleId,
      enabled: true,
      when: `type = ${kind}`,
      who: [],
      looks: { titleTemplate: "{{title}}", fields: [] },
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const res = await processEvent(event, {
      rules: [compileRule(rule)],
      directory: createStaticDirectory({}),
      enqueue: async () => undefined,
      hooks: createDedupHooks({ redis, repo: createPgAlertRepo(pool) }),
      publishAlert: async (ae: AlertEvent) => {
        streamIds.push((await redis.xadd(STREAM_ALERTS, "*", "data", JSON.stringify(ae))) as string);
      },
      logger: { error: (m: string) => { throw new Error(m); } },
    });
    expect(res.alerts).toHaveLength(1);
    const alertId = res.alerts[0]!.id;
    alertIds.push(alertId);

    await waitFor(async () => {
      const r = await pool.query("SELECT 1 FROM runbook_runs WHERE alert_id = $1", [alertId]);
      return r.rowCount ? true : undefined;
    });
    // Give a second consumer the chance to (wrongly) pick the entry up too.
    await new Promise((r) => setTimeout(r, 1500));

    const runs = await pool.query("SELECT runbook_id FROM runbook_runs WHERE alert_id = $1", [alertId]);
    expect(runs.rows.map((r: { runbook_id: string }) => r.runbook_id)).toEqual([runbookId]);
    const audit = await pool.query("SELECT 1 FROM alert_audit WHERE alert_id = $1 AND action = 'step_executed'", [alertId]);
    expect(audit.rowCount).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });
});
