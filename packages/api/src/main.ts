import pg from "pg";
import { Redis } from "ioredis";
import { CHANNEL_UI_PUSH } from "@alerting/shared";
import { createDeliveryQueue, createNtfyChannel, createUiChannel, registerChannel } from "@alerting/delivery";
import { startIngestService, type IngestService } from "@alerting/ingest";
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

let publishWarned = false;
const stores = createPgAlertStores(pool);

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

const server = createServer({
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
if (process.env.DATABASE_URL && process.env.REDIS_URL) {
  startIngestService({ databaseUrl: process.env.DATABASE_URL, redisUrl: process.env.REDIS_URL })
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
  void Promise.allSettled([delivery.stop(), ingest?.stop(), config?.close()])
    .then(() => Promise.allSettled([pool.end(), redis.quit(), configRedis?.quit(), deliveryRedis.quit(), subRedis.quit()])).then(() => process.exit(0));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
