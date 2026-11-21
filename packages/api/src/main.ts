import pg from "pg";
import { Redis } from "ioredis";
import { CHANNEL_UI_PUSH, type UiPush } from "@alerting/shared";
import { createDeliveryQueue, createNtfyChannel, createUiChannel, registerChannel } from "@alerting/delivery";
import {
  createDefaultActions,
  createGroupNotifier,
  createPgRunStore,
  createRunbookRegistry,
  createRunbookRoutes,
  createRunner,
  migrateRunbooks,
} from "@alerting/runbooks";
import { startIngestService, startSchemaMapping, type IngestService, type SchemaMapping } from "@alerting/ingest";
import { createConfigStore, migrate, type ConfigStore } from "@alerting/config";
import { createServer } from "./server.js";
import { createUiPushHub } from "./stream/sse.js";
import { createPgAlertStores, createPgEventLoader } from "./routes/alerts/store.js";
import { createRedisRecentEvents } from "./routes/events/http.js";

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

// Runbooks: runs, approvals (audit goes to the alerts audit store). Lazy connections, so the API still starts when Postgres/Redis are down.
const runbooksReady = migrateRunbooks(pool);
runbooksReady.catch((err: unknown) => console.error("runbooks migration failed:", (err as Error).message));
// The registry shares the config store (and its change events), so runbooks created via /api/runbooks are picked up.
const runbookRegistry = config
  ? createRunbookRegistry(config, { onError: (err) => console.error("runbook registry:", err.message) })
  : undefined;
const notifyGroup = createGroupNotifier({
  getGroup: async (id) => (config ? config.get("group", id) : undefined),
  enqueue: (n) => delivery.enqueue(n),
});
const stores = createPgAlertStores(pool);
// One audit log: runbook audit entries are written to (and read from) the alerts audit store.
const runStore = createPgRunStore(pool, { ready: runbooksReady });
const runner = createRunner({
  store: {
    ...runStore,
    appendAudit: (entry) => stores.audit.append(entry),
    listAudit: async ({ alertId, limit } = {}) => {
      const rows = alertId
        ? await stores.audit.listByAlert(alertId)
        : (await stores.audit.list({ limit: limit ?? 100 })).reverse();
      return limit === undefined ? rows : rows.slice(-limit);
    },
  },
  actions: createDefaultActions({ notifyGroup }),
  onUpdate: (run) => {
    const push: UiPush = { type: "alert", alertId: run.alertId, kind: "updated" };
    redis.publish(CHANNEL_UI_PUSH, JSON.stringify(push)).catch(() => {
      /* UI push is best effort */
    });
  },
});
// Best effort: fail runs left "running" by a previous process.
runbooksReady
  .then(() => runner.recoverStale())
  .then((n) => n > 0 && console.log(`runbooks: recovered ${n} interrupted run(s)`))
  .catch((err: unknown) => console.error("runbooks stale-run recovery failed:", (err as Error).message));
// The alert worker (startRunbookWorker) is wired here once alerts are persisted (needs loadAlert/loadEvent).
let publishWarned = false;

const server = createServer({
  runbooks: runbookRegistry ? createRunbookRoutes({ runner, registry: runbookRegistry }) : undefined,
  delivery,
  config,
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
const schemaMapping: SchemaMapping | undefined = config ? startSchemaMapping(config) : undefined;
if (process.env.DATABASE_URL && process.env.REDIS_URL) {
  (schemaMapping ? schemaMapping.ready : Promise.resolve())
    .then(() =>
      startIngestService({
        databaseUrl: process.env.DATABASE_URL as string,
        redisUrl: process.env.REDIS_URL as string,
        mapEvent: schemaMapping?.mapEvent,
      }),
    )
    .then((s) => {
      ingest = s;
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
  void Promise.allSettled([delivery.stop(), ingest?.stop(), runbookRegistry?.close(), schemaMapping?.close(), config?.close()])
    .then(() => Promise.allSettled([pool.end(), redis.quit(), configRedis?.quit(), deliveryRedis.quit(), subRedis.quit()])).then(() => process.exit(0));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
