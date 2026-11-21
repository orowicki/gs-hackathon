import pg from "pg";
import { Redis } from "ioredis";
import { CHANNEL_UI_PUSH } from "@alerting/shared";
import {
  createDeliveryQueue,
  createEmailChannel,
  createNtfyChannel,
  createUiChannel,
  emailConfigFromEnv,
  registerChannel,
} from "@alerting/delivery";
import { createRunbookRoutes } from "@alerting/runbooks";
import { startIngestService, startSchemaMapping, type IngestService, type SchemaMapping } from "@alerting/ingest";
import { createConfigStore, migrate, type ConfigStore } from "@alerting/config";
import { startConfigWatch } from "./config-watch.js";
import { createServer } from "./server.js";
import { createUiPushHub } from "./stream/sse.js";
import { createRunbookRuntime } from "./runbooks-runtime.js";
import { createPgAlertStores, createPgEventLoader } from "./routes/alerts/store.js";
import { createRedisRecentEvents } from "./routes/events/http.js";
import { createPgEventList } from "./routes/events/list.js";
import { createRedisPreview } from "./routes/preview.routes.js";

const port = Number(process.env.PORT ?? 3000);

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 1500,
});
pool.on("error", (err) => console.error("pg pool error:", err.message));

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
const redis = new Redis(redisUrl, {
  lazyConnect: true,
  connectTimeout: 1500,
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  retryStrategy: (times) => Math.min(times * 500, 5000),
});
redis.on("error", () => {
  /* surfaced via /health; avoid log spam */
});

// Dedicated connection for the delivery worker: waits through outages, never crashes.
const deliveryRedis = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
  retryStrategy: (times) => Math.min(times * 500, 5000),
});
deliveryRedis.on("error", () => {
  /* reconnects automatically */
});
registerChannel(createUiChannel(deliveryRedis));
registerChannel(
  createNtfyChannel({
    baseUrl: process.env.NTFY_URL ?? "http://localhost:80",
    publicUrl: process.env.PUBLIC_URL ?? "http://localhost:3000",
  }),
);
registerChannel(createEmailChannel(emailConfigFromEnv()));
const delivery = createDeliveryQueue(deliveryRedis);
let stopping = false;
async function startWorker(): Promise<void> {
  while (!stopping) {
    try {
      await delivery.start();
      return;
    } catch (err) {
      console.error("delivery worker start failed, retrying:", (err as Error).message);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
void startWorker();

// One SUBSCRIBE connection, fanned out in-process to all SSE clients.
const uiHub = createUiPushHub();
const subRedis = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
  retryStrategy: (times) => Math.min(times * 500, 5000),
});
subRedis.on("error", () => {
  /* reconnects automatically */
});
subRedis.subscribe(CHANNEL_UI_PUSH).catch(() => {
  /* resubscribed on reconnect */
});
subRedis.on("message", (_ch: string, json: string) => {
  uiHub.publish(json);
});

// Config store: shared pool (close() does not end it); own Redis for change publishing that fails fast.
// Alert stores run migrate lazily too, and it is idempotent.
let config: ConfigStore | undefined;
let configRedis: Redis | undefined;
if (process.env.DATABASE_URL) {
  try {
    await migrate(pool);
  } catch (err) {
    console.error("config migrate failed:", (err as Error).message);
  }
  configRedis = new Redis(redisUrl, {
    connectTimeout: 1500,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: (times) => Math.min(times * 500, 5000),
  });
  configRedis.on("error", () => {
    /* change publishing is best effort */
  });
  config = createConfigStore({ pool, redis: configRedis });
}
// Live YAML reload: files load on start only when the entity is missing (API edits survive), later changes apply.
const configWatcher = config
  ? startConfigWatch(config, process.env.CONFIG_DIR ?? "./config")
  : undefined;

// Runbooks: runs, approvals (audit goes to the alerts audit store). Lazy connections, so the API still starts when Postgres/Redis are down.
const runtime = createRunbookRuntime({
  pool,
  redis,
  config,
  enqueue: (n) => delivery.enqueue(n),
  onError: (err) => console.error("runbook registry:", err.message),
});
const { runner, ready: runbooksReady } = runtime;
const runbookRegistry = runtime.registry;
const stores = createPgAlertStores(pool);
// Best effort: fail runs left "running" by a previous process (API process only, never in the runbook worker).
runbooksReady
  .then(() => runner.recoverStale())
  .then((n) => n > 0 && console.log(`runbooks: recovered ${n} interrupted run(s)`))
  .catch((err: unknown) => console.error("runbooks stale-run recovery failed:", (err as Error).message));
// Alerts start runbooks in the separate runbook worker (runbook-worker.ts), not in this process.
let publishWarned = false;

const server = createServer({
  runbooks: runbookRegistry ? createRunbookRoutes({
        runner,
        registry: runbookRegistry,
        loadAlert: runtime.loadAlert,
        loadEvent: runtime.loadEvent,
        // Approvers check: only members of a step's `approvers` group may approve or skip it.
        getGroup: async (id) => (config ? ((await config.get("group", id)) as { memberIds?: string[] } | undefined) : undefined),
      }) : undefined,
  delivery,
  config,
  pool,
  subscribeUiPush(onMessage) {
    return uiHub.subscribe(onMessage);
  },
  alerts: {
    ...stores,
    events: createPgEventLoader(pool),
    publish(push) {
      redis.publish(CHANNEL_UI_PUSH, JSON.stringify(push)).catch((err: unknown) => {
        if (publishWarned) return;
        publishWarned = true;
        console.error("ui push publish failed:", (err as Error).message);
      });
    },
  },
  recentEvents: createRedisRecentEvents(redis),
  eventList: createPgEventList(pool),
  preview: config ? createRedisPreview({ redis, config }) : undefined,
  async checkPostgres() {
    await pool.query("SELECT 1");
    return true;
  },
  async checkRedis() {
    if (redis.status === "wait" || redis.status === "end") await redis.connect();
    return (await redis.ping()) === "PONG";
  },
});

server.listen(port, () => console.log(`api listening on :${port}`));

// Ingest (sources, http route registry, parse worker) runs in-process: the http plugin registry is per process.
let ingest: IngestService | undefined;
// Events are mapped onto the live schema registry (reloads on config changes) so common fields and schema_id are set.
// Ingest starts only after the first successful schema load (async: does not block server.listen).
const ingestEnabled = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);
const schemaMapping: SchemaMapping | undefined = config && ingestEnabled ? startSchemaMapping(config) : undefined;
if (ingestEnabled) {
  (schemaMapping ? schemaMapping.ready : Promise.resolve())
    .then(() =>
      stopping
        ? undefined
        : startIngestService({
            databaseUrl: process.env.DATABASE_URL as string,
            redisUrl: process.env.REDIS_URL as string,
            mapEvent: schemaMapping?.mapEvent,
          }),
    )
    .then((s) => {
      if (!s) return;
      if (stopping) void s.stop();
      else ingest = s;
    })
    .catch((err: unknown) => console.error("ingest failed to start:", err));
} else {
  console.log("ingest disabled: DATABASE_URL and REDIS_URL not both set");
}

function shutdown(): void {
  setTimeout(() => process.exit(0), 3000).unref();
  stopping = true;
  server.close();
  server.closeAllConnections?.();
  void Promise.allSettled([delivery.stop(), Promise.resolve(ingest?.stop()).finally(() => schemaMapping?.close()), runbookRegistry?.close(), Promise.race([configWatcher?.close(), new Promise((r) => setTimeout(r, 1500))]).finally(() => config?.close())])
    .then(() => Promise.allSettled([pool.end(), redis.quit(), configRedis?.quit(), deliveryRedis.quit(), subRedis.quit()])).then(() => process.exit(0));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
