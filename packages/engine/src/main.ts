import { Redis } from "ioredis";
import pg from "pg";
import { createConfigStore } from "@alerting/config";
import { createDeliveryQueue } from "@alerting/delivery";
import type { EngineHooks } from "./index.js";
import { createDedupHooks, createEngine, createGrouping, createPgAlertRepo, createThrottle, throttleConfigFromEnv } from "./index.js";

const redisUrl = process.env.REDIS_URL;
const databaseUrl = process.env.DATABASE_URL;
if (!redisUrl || !databaseUrl) {
  console.error("engine: REDIS_URL and DATABASE_URL are required");
  process.exit(1);
}
const redis = new Redis(redisUrl);
const store = createConfigStore({ databaseUrl, redisUrl });
const pool = new pg.Pool({ connectionString: databaseUrl, statement_timeout: 10_000 });
pool.on("error", (err) => console.error(`engine: postgres pool error: ${err.message}`));
const queue = createDeliveryQueue(redis);
const throttle = createThrottle({ redis, ...throttleConfigFromEnv(), enqueue: (n) => queue.enqueue(n) });
const dedupHooks = createDedupHooks({ redis, repo: createPgAlertRepo(pool), throttle });
// A flushed group has no alert context, so it skips the dedup hook (its id fix-up only matters for
// per-alert notifications) and goes through the throttle straight to the delivery queue.
const grouping = createGrouping({
  redis,
  deliver: async (n) => {
    const out = await throttle.beforeEnqueue(n);
    if (out) await queue.enqueue(out);
  },
});
const hooks: EngineHooks = {
  ...dedupHooks,
  beforeEnqueue: async (n, ctx) => {
    const buffered = await grouping.beforeEnqueue(n, ctx);
    return buffered ? dedupHooks.beforeEnqueue!(buffered, ctx) : null;
  },
};
const engine = createEngine({ redis, store, hooks });
await engine.start();
throttle.start();
grouping.start();
console.log("engine started");

const shutdown = async () => {
  await engine.stop();
  await grouping.stop();
  await throttle.stop();
  await store.close();
  await pool.end();
  redis.disconnect();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
