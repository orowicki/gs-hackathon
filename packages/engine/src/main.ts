import { Redis } from "ioredis";
import pg from "pg";
import { createConfigStore } from "@alerting/config";
import { createDeliveryQueue } from "@alerting/delivery";
import { createRunbookRegistry } from "@alerting/runbooks";
import type { EngineHooks } from "./index.js";
import { withRunbookLink } from "./runbook-link.js";
import { createDedupHooks, createEngine, createGrouping, createPgAlertRepo, createThrottle, throttleConfigFromEnv } from "./index.js";

const redisUrl = process.env.REDIS_URL;
const databaseUrl = process.env.DATABASE_URL;
if (!redisUrl || !databaseUrl) {
  console.error("engine: REDIS_URL and DATABASE_URL are required");
  process.exit(1);
}
const redis = new Redis(redisUrl, { enableAutoPipelining: true });
const store = createConfigStore({ databaseUrl, redisUrl });
// Upserts take at most 4 connections (batched); the rest serve get/resolve and replays.
// ENGINE_PG_POOL_MAX (default 10): mind max_connections x the number of engines.
const poolMax = Math.max(1, Math.floor(Number(process.env.ENGINE_PG_POOL_MAX)) || 10);
const pool = new pg.Pool({
  connectionString: databaseUrl,
  statement_timeout: 10_000,
  // waiting for a free connection is bounded too (see PENDING_MS in dedup/hooks.ts)
  connectionTimeoutMillis: 5_000,
  max: poolMax,
});
pool.on("error", (err) => console.error(`engine: postgres pool error: ${err.message}`));
const runbooks = createRunbookRegistry(store, { onError: (err) => console.error(`engine: runbook registry: ${err.message}`) });
// Same default as the app service in docker-compose.yml (the worker service sets no PUBLIC_URL).
const publicUrl = process.env.PUBLIC_URL || "http://localhost:3000";
if (!process.env.PUBLIC_URL) console.warn(`engine: PUBLIC_URL is not set: runbook links use ${publicUrl}`);
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
    if (!buffered) return null;
    const out = await dedupHooks.beforeEnqueue!(buffered, ctx);
    return out ? withRunbookLink(out, ctx, runbooks, publicUrl) : null;
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
  await runbooks.close();
  await store.close();
  await pool.end();
  redis.disconnect();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
