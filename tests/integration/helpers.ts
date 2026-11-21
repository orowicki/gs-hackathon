import http from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { Redis } from "ioredis";
import {
  GROUP_ENGINE,
  GROUP_PARSE,
  LIST_RECENT_EVENTS,
  PREFIX,
  STREAM_ALERTS,
  STREAM_EVENTS,
  STREAM_RAW_EVENTS,
  dedupKey,
  throttleKey,
  type Notification,
  type Source,
} from "@alerting/shared";
import { createConfigStore, migrate, type ConfigStore, type Kind } from "@alerting/config";
import {
  createParserCache,
  migrateIngest,
  startIngest,
  startParseWorker,
  type IngestRunner,
  type ParseWorker,
} from "@alerting/ingest";
import { createSchemaRegistry, type SchemaRegistry } from "@alerting/schemas";
import {
  createDedupHooks,
  createEngine,
  createPgAlertRepo,
  createThrottle,
  type Engine,
  type Throttle,
} from "@alerting/engine";
import {
  ChannelRegistry,
  createDeliveryQueue,
  createNtfyChannel,
  createUiChannel,
  type DeliveryQueue,
} from "@alerting/delivery";
import { createServer } from "../../packages/api/src/server.ts";
import { KIND_ORDER, loadConfigDir, REPO_ROOT, type SeedKind } from "../../scripts/seed/seed.ts";
import { join } from "node:path";

export const PUBLIC_URL = "http://pipeline.test";

export const enabled = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);

export async function waitFor<T>(what: string, fn: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const STORE_KIND: Record<SeedKind, Kind> = {
  person: "person",
  group: "group",
  preference: "preference",
  schema: "schema",
  source: "source",
  rule: "rule",
  runbook: "runbook",
};

export interface NtfyStub {
  url: string;
  received: Array<Record<string, unknown>>;
  close(): Promise<void>;
}

export async function startNtfyStub(): Promise<NtfyStub> {
  const received: Array<Record<string, unknown>> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      } catch {
        /* ignore garbage */
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    received,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

export interface Stack {
  run: string;
  sourceId: string;
  pool: pg.Pool;
  redis: Redis;
  store: ConfigStore;
  ingestUrl: string;
  ntfy: NtfyStub;
  /** Notifications published by the ui channel (CHANNEL_UI_PUSH "notification" messages). */
  uiNotifications: Notification[];
  startedAtMs: number;
  stop(): Promise<void>;
}

/**
 * Wires ingest (http source + parse worker with schema mapping), engine (dedup + throttle),
 * delivery (ui + stubbed ntfy) and the API http server in-process, the same way the packages'
 * main.ts files do, against the seeded config/ files. `run` is a unique suffix; the posted
 * events must carry it in their dedup keys (`dedupKeys`) so alerts and Redis dedup state are
 * run-scoped and only those keys are touched.
 *
 * Trade-off: engine, delivery queue and the Redis stream names are fixed by the production code
 * (no prefix option), so a developer's running engine could compete for this run's events. Config
 * entities are loaded under their real ids (rules reference real people/groups) and restored in
 * stop() or when setup fails.
 */
export async function startStack(run: string, dedupKeys: string[]): Promise<Stack> {
  const sourceId = `it-pipeline-${run}`;
  const databaseUrl = process.env.DATABASE_URL as string;
  const redisUrl = process.env.REDIS_URL as string;
  const startedAtMs = Date.now();
  const quiet = { info() {}, warn() {}, error: (m: string) => console.error(m) };

  const pool = new pg.Pool({ connectionString: databaseUrl, statement_timeout: 10_000 });
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const subscriber = new Redis(redisUrl, { maxRetriesPerRequest: null });
  await migrate(pool);
  await migrateIngest(pool);
  const store = createConfigStore({ pool, redis });

  // Load config/ into the store. The files are authoritative for this run: existing entities with
  // the same ids are overwritten and restored (or deleted if absent) in stop() or on setup failure.
  const data = loadConfigDir(join(REPO_ROOT, "config"));
  const restore: Array<() => Promise<unknown>> = [];
  for (const kind of KIND_ORDER) {
    if (kind === "source" || kind === "runbook") continue;
    for (const { id, entity } of data[kind]) {
      const k = STORE_KIND[kind];
      const prev = await store.get(k, id);
      await store.upsert(k, entity as never);
      restore.unshift(() => (prev === undefined ? store.delete(k, id) : store.upsert(k, prev as never)));
    }
  }
  const ruleIds = data.rule.map((r) => r.id);
  const recipients = data.person.map((p) => p.id);
  const clearRedis = async () => {
    const keys = ruleIds.flatMap((r) => dedupKeys.map((k) => dedupKey(r, k)));
    if (keys.length) await redis.del(...keys);
  };
  await clearRedis();

  const build = async (): Promise<Stack> => {

  // The http source this run posts to.
  const source: Source = {
    id: sourceId,
    name: `pipeline test ${run}`,
    enabled: true,
    type: "http",
    config: {},
    parser: { type: "json" },
  };
  await store.upsert("source", source);

  // Ingest: only this run's source is started; parse worker maps events with the stored schemas.
  const only = <T extends { id: string }>(l: T[]) => l.filter((s) => s.id === sourceId);
  const ownStore: Pick<ConfigStore, "list" | "get" | "onChange"> = {
    list: (async (kind: Kind) => (kind === "source" ? only(await store.list("source")) : store.list(kind))) as ConfigStore["list"],
    get: store.get.bind(store),
    onChange: ((kind: Kind, cb: (c: { id: string; op: "upsert" | "delete" }) => unknown) =>
      store.onChange(kind as never, ((c: { id: string; op: "upsert" | "delete" }) =>
        kind === "source" && c.id !== sourceId ? undefined : cb(c)) as never)) as ConfigStore["onChange"],
  };
  const registry: SchemaRegistry = createSchemaRegistry(store);
  await registry.ready;
  const parsers = await createParserCache(ownStore);
  const worker: ParseWorker = startParseWorker({
    redis,
    pool,
    getParser: (id) => parsers.get(id),
    consumer: `it-parse-${run}`,
    mapEvent: (e) => {
      const c = registry.classify(e.parsed);
      return { ...e, parsed: c.parsed as typeof e.parsed, schemaId: c.schemaId, common: c.common as typeof e.common };
    },
    logger: quiet,
  });
  const runner: IngestRunner = await startIngest({ store: ownStore, redis, redisUrl, logger: quiet });
  await runner.settled();

  // API: POST /ingest/:sourceId
  const server = createServer({ checkPostgres: async () => true, checkRedis: async () => true });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const ingestUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/ingest/${sourceId}`;

  // Delivery: private registry so other workers' channels are not involved; ntfy goes to a local stub.
  const ntfy = await startNtfyStub();
  const channels = new ChannelRegistry();
  channels.register(createUiChannel(redis));
  channels.register(createNtfyChannel({ baseUrl: ntfy.url, publicUrl: PUBLIC_URL, timeoutMs: 1000 }));
  const delivery: DeliveryQueue = createDeliveryQueue(redis, { registry: channels, pollMs: 20 });
  await delivery.start();

  const uiNotifications: Notification[] = [];
  await subscriber.subscribe(`${PREFIX}ui:push`);
  subscriber.on("message", (_ch, json: string) => {
    try {
      const m = JSON.parse(json) as { type?: string; notification?: Notification };
      if (m.type === "notification" && m.notification) uiNotifications.push(m.notification);
    } catch {
      /* not ours */
    }
  });

  // Engine: dedup + throttle hooks exactly as packages/engine/src/main.ts, with a generous throttle.
  const throttle: Throttle = createThrottle({ redis, max: 1000, windowMs: 60_000, enqueue: (n) => delivery.enqueue(n) });
  const hooks = createDedupHooks({ redis, repo: createPgAlertRepo(pool), throttle });
  const engine: Engine = createEngine({ redis, store, hooks, logger: quiet, blockMs: 200 });
  await engine.start();
  throttle.start();

  return {
    run,
    sourceId,
    pool,
    redis,
    store,
    ingestUrl,
    ntfy,
    uiNotifications,
    startedAtMs,
    async stop() {
      const errs: unknown[] = [];
      const step = async (f: () => unknown) => {
        try {
          await f();
        } catch (e) {
          errs.push(e);
        }
      };
      await step(() => engine.stop());
      await step(() => throttle.stop());
      await step(() => delivery.stop());
      await step(() => new Promise((r) => (server.closeAllConnections(), server.close(r))));
      await step(() => runner.stop());
      await step(() => worker.stop());
      parsers.close();
      registry.close();
      await step(() => ntfy.close());

      // Postgres: alerts of this run's events, the events, then what this run seeded or created.
      const eventIds: string[] = [];
      const alertIds: string[] = [];
      await step(async () => {
        const ev = await pool.query<{ id: string }>("SELECT id FROM events WHERE source_id = $1", [sourceId]);
        const ids = ev.rows.map((r) => r.id);
        eventIds.push(...ids);
        const al = await pool.query<{ id: string }>("SELECT id FROM alerts WHERE data->>'eventId' = ANY($1::text[])", [ids]);
        alertIds.push(...al.rows.map((r) => r.id));
        await pool.query("DELETE FROM alerts WHERE id = ANY($1::text[])", [alertIds]);
        await pool.query("DELETE FROM events WHERE source_id = $1", [sourceId]);
      });
      await step(() => store.delete("source", sourceId));
      for (const undo of restore) await step(undo);

      // Redis: this run's stream entries and recent-events rows, plus its dedup/throttle keys.
      await step(async () => {
        const from = `${startedAtMs - 1000}-0`;
        for (const stream of [STREAM_RAW_EVENTS, STREAM_EVENTS, STREAM_ALERTS]) {
          const rows = (await redis.xrange(stream, from, "+")) as Array<[string, string[]]>;
          const mine = rows
            .filter(([, f]) => {
              const d = f[1] ?? "";
              return d.includes(sourceId) || eventIds.some((e) => d.includes(e)) || alertIds.some((a) => d.includes(a));
            })
            .map(([id]) => id);
          if (mine.length) await redis.xdel(stream, ...mine);
        }
        for (const raw of await redis.lrange(LIST_RECENT_EVENTS, 0, 200)) {
          if (raw.includes(sourceId)) await redis.lrem(LIST_RECENT_EVENTS, 0, raw);
        }
        for (const r of ruleIds) {
          for (const k of dedupKeys) {
            const seen = await redis.keys(`${PREFIX}dedupseen:${r}:${k}:*`);
            if (seen.length) await redis.del(...seen);
          }
        }
        await clearRedis();
        // Throttle counters are keyed by real recipient ids: undo only this run's increments.
        for (const n of ntfy.received) {
          const who = String(n.topic).replace(/^alerting-/, "");
          const key = throttleKey(who, "ntfy");
          if ((await redis.decr(key)) <= 0) await redis.del(key);
        }
        // Consumers this run registered in the shared consumer groups.
        for (const [stream, group, prefix] of [
          [STREAM_RAW_EVENTS, GROUP_PARSE, `it-parse-${run}`],
          [STREAM_EVENTS, GROUP_ENGINE, `engine-${process.pid}-`],
        ] as const) {
          const cs = (await redis.xinfo("CONSUMERS", stream, group)) as unknown[][];
          for (const c of cs) {
            const name = String(c[1]);
            if (name.startsWith(prefix)) await redis.xgroup("DELCONSUMER", stream, group, name);
          }
        }
      });
      await step(() => pool.end());
      redis.disconnect();
      subscriber.disconnect();
      if (errs.length) console.error("pipeline test cleanup errors:", errs);
    },
  };
  };
  try {
    return await build();
  } catch (e) {
    for (const undo of restore) await undo().catch(() => undefined);
    throw e;
  }
}
