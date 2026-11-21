import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { Redis } from "ioredis";
import { createConfigStore, migrate, type ConfigStore } from "@alerting/config";
import {
  compileRule,
  createDedupHooks,
  createDirectory,
  createPgAlertRepo,
  processEvent,
  type CompiledRule,
} from "@alerting/engine";
import {
  createParserCache,
  migrateIngest,
  startParseWorker,
  startSchemaMapping,
  toRawMessage,
  type ParseWorker,
  type SchemaMapping,
} from "@alerting/ingest";
import { STREAM_EVENTS, dedupKey as redisDedupKey, type Alert, type Event, type Rule, type Source } from "@alerting/shared";
import { REPO_ROOT, loadConfigDir, seed, type SeedClient, type SeedKind } from "../seed/seed.ts";
import { paymentsCritical, pricingLatency, tradeRejected, workflowFailed } from "./events.ts";

// The demo path: ingest starts BEFORE the schemas are seeded (as in compose, where the worker boots
// before `just seed`), then one event of each Appendix A type (plus a repeat) flows through the real
// parse worker + schema mapping, and through the engine's rule matching and dedup hooks.
const enabled = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);

function lcg(seed: number) {
  let s = seed;
  return () => (s = (s * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32;
}

describe.skipIf(!enabled)("demo path: events get a schema and raise realistic alerts", () => {
  const run = randomUUID().slice(0, 8);
  const sourceId = `it-demo-${run}`;
  const stream = `test:${run}:raw`;
  const group = `${run}-g`;
  let pool: pg.Pool;
  let redis: Redis;
  let store: ConfigStore;
  let mapping: SchemaMapping;
  let worker: ParseWorker;
  let parsers: Awaited<ReturnType<typeof createParserCache>>;
  let rules: CompiledRule[];
  const createdIds: string[] = [];
  const restore: { kind: "schema" | "rule"; entity: never }[] = [];
  const keys: string[] = [];
  const eventIds: string[] = [];

  const storeClient = (): SeedClient => ({
    async get(kind: SeedKind, id: string) {
      if (kind === "preference" || kind === "source") return undefined;
      return ((await store.get(kind, id)) ?? undefined) as Record<string, unknown> | undefined;
    },
    async put(kind: SeedKind, id: string, entity) {
      if (kind === "preference") {
        await store.upsert("preference", { ...entity, id } as never);
        return;
      }
      if (kind === "source") return;
      await store.upsert(kind, entity as never);
    },
  });

  /** Send one demo line through the isolated raw stream and wait for its stored event. */
  async function send(line: string): Promise<Event> {
    const before = eventIds.length;
    await redis.xadd(stream, "*", "data", JSON.stringify(toRawMessage(sourceId, line)));
    for (let i = 0; i < 100; i++) {
      const r = await pool.query<{ id: string }>(
        "SELECT id FROM events WHERE source_id = $1 ORDER BY received_at, id",
        [sourceId],
      );
      if (r.rows.length > before) {
        const id = r.rows.map((x) => x.id).find((x) => !eventIds.includes(x)) as string;
        eventIds.push(id);
        const e = await pool.query(
          "SELECT id, source_id, received_at, raw, parsed, schema_id, common FROM events WHERE id = $1",
          [id],
        );
        const row = e.rows[0];
        return {
          id: row.id,
          sourceId: row.source_id,
          receivedAt: new Date(row.received_at).toISOString(),
          raw: row.raw,
          parsed: row.parsed,
          schemaId: row.schema_id,
          common: row.common,
        } as Event;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("timed out waiting for the event to be stored");
  }

  let hooks: ReturnType<typeof createDedupHooks>;
  let directory: ReturnType<typeof createDirectory>;
  async function engine(event: Event): Promise<Alert[]> {
    const res = await processEvent(event, { rules, directory, enqueue: () => undefined, hooks });
    expect(res.failed).toEqual([]);
    return res.alerts;
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    redis = new Redis(process.env.REDIS_URL as string, { maxRetriesPerRequest: null });
    await migrate(pool);
    await migrateIngest(pool);
    store = createConfigStore({ pool, redis });
    await store.upsert("source", {
      id: sourceId,
      name: "demo path",
      enabled: true,
      type: "http",
      config: {},
      parser: { type: "json" },
    } as Source);

    // 1. ingest first, against the schema store as it is now (possibly empty)
    mapping = startSchemaMapping(store);
    await mapping.ready;
    parsers = await createParserCache(store);
    worker = startParseWorker({
      redis,
      pool,
      getParser: (id) => parsers.get(id),
      mapEvent: mapping.mapEvent,
      stream,
      group,
      blockMs: 200,
    });

    // 2. then seed schemas, rules, people and groups from config/ like `just seed` does
    const data = loadConfigDir(join(REPO_ROOT, "config"));
    data.source = [];
    data.preference = [];
    const r = await seed(storeClient(), data);
    createdIds.push(...r.createdIds);
    // seed keeps what exists; a stale copy in a shared DB must not hide a config problem, so the
    // repo's schemas and rules win for the duration of the test and are restored afterwards
    for (const kind of ["schema", "rule"] as const) {
      for (const { id, entity } of data[kind]) {
        const prior = await store.get(kind, id);
        if (prior && JSON.stringify({ ...prior, createdAt: 0, updatedAt: 0 }) !== JSON.stringify({ ...entity, createdAt: 0, updatedAt: 0 })) {
          restore.push({ kind, entity: prior as never });
          await store.upsert(kind, entity as never);
        }
      }
    }
    const all = (await store.list("rule")) as Rule[];
    rules = data.rule.map(({ id }) => compileRule(all.find((x) => x.id === id) as Rule));
    directory = createDirectory(store);
    hooks = createDedupHooks({ redis, repo: createPgAlertRepo(pool) });
  });

  afterAll(async () => {
    await worker?.stop();
    mapping?.close();
    parsers?.close();
    if (eventIds.length > 0) {
      await pool.query("DELETE FROM alerts WHERE data->>'eventId' = ANY($1)", [eventIds]);
      await pool.query("DELETE FROM events WHERE id = ANY($1)", [eventIds]);
      const entries = await redis.xrange(STREAM_EVENTS, "-", "+");
      for (const [id, f] of entries) if (eventIds.includes(JSON.parse(f[1] ?? "{}").id)) await redis.xdel(STREAM_EVENTS, id);
    }
    for (const k of keys) await redis.del(k);
    for (const ref of createdIds) {
      const [kind, id] = ref.split("/") as [SeedKind, string];
      if (kind !== "preference" && kind !== "source") await store?.delete(kind, id).catch(() => undefined);
    }
    for (const { kind, entity } of restore) await store?.upsert(kind, entity).catch(() => undefined);
    await store?.delete("source", sourceId);
    await store?.close();
    await redis?.del(stream);
    await Promise.allSettled([redis?.quit(), pool?.end()]);
  });

  it("maps all three Appendix A types, fires >= 3 rules with real severities, and dedups a repeat", async () => {
    const rng = lcg(7);
    const now = new Date("2026-10-23T09:14:02.331Z");
    // unique dedup identities per run; shapes come from the demo generators
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tweak = (line: string, f: (o: Record<string, any>) => void): string => {
      const o = JSON.parse(line);
      f(o);
      return JSON.stringify(o);
    };
    const wf = tweak(workflowFailed(rng, now).line, (o) => {
      o.workflowName = "order-settlement";
      o.environment = "prod";
      o.severity = "CRITICAL";
      o.step = `book-trade-${run}`;
    });
    const metric = tweak(paymentsCritical(rng, now).line, (o) => (o.alertname = `HighErrorRate-${run}`));
    const pricing = tweak(pricingLatency(rng, now).line, (o) => {
      o.alertname = `HighLatency-${run}`;
      o.labels.severity = "warning";
    });
    const trade = tweak(tradeRejected(rng, now).line, (o) => {
      o.payload.desk = "rates";
      o.payload.notional = 25_000_000;
      o.payload.tradeId = `T-${run}`;
    });

    const events = [await send(wf), await send(metric), await send(pricing), await send(trade)];
    for (const e of events) expect(e.schemaId, JSON.stringify(e.parsed)).toMatch(/^schema-/);
    expect(events.map((e) => e.schemaId)).toEqual([
      "schema-workflow-failed",
      "schema-metric-breach",
      "schema-metric-breach",
      "schema-trade-rejected",
    ]);
    for (const e of events) expect((e.common as Record<string, unknown>).dedupKey).toBeTruthy();

    const alerts: Alert[] = [];
    for (const e of events) alerts.push(...(await engine(e)));
    const byRule = new Map(alerts.map((a) => [a.ruleId, a]));
    for (const a of alerts) keys.push(redisDedupKey(a.ruleId, a.dedupKey));
    expect([...byRule.keys()].sort()).toEqual([
      "anna-payments-critical",
      "pricing-engine-warnings",
      "rates-trade-rejected",
      "settlements-workflow-failed",
    ]);
    expect(byRule.get("settlements-workflow-failed")?.severity).toBe("critical");
    expect(byRule.get("anna-payments-critical")?.severity).toBe("critical");
    expect(byRule.get("pricing-engine-warnings")?.severity).toBe("warning");
    expect(byRule.get("rates-trade-rejected")?.severity).toBe("info");
    for (const a of alerts) expect(a.count).toBe(1);

    // the same metric again: no new alert, count goes up
    const again = await send(metric);
    expect(again.id).not.toBe(events[1]?.id);
    const second = await engine(again);
    expect(second).toHaveLength(1);
    expect(second[0]?.id).toBe(byRule.get("anna-payments-critical")?.id);
    expect(second[0]?.count).toBe(2);
    const n = await pool.query("SELECT count(*)::int AS n FROM alerts WHERE rule_id = 'anna-payments-critical' AND dedup_key = $1", [
      byRule.get("anna-payments-critical")?.dedupKey,
    ]);
    expect(n.rows[0].n).toBe(1);
  });
});
