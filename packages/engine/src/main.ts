import { Redis } from "ioredis";
import pg from "pg";
import { createConfigStore } from "@alerting/config";
import { createDeliveryQueue } from "@alerting/delivery";
import { createDedupHooks, createEngine, createPgAlertRepo, createThrottle, throttleConfigFromEnv } from "./index.js";

const redisUrl = process.env.REDIS_URL;
const databaseUrl = process.env.DATABASE_URL;
if (!redisUrl || !databaseUrl) {
  console.error("engine: REDIS_URL and DATABASE_URL are required");
  process.exit(1);
}
const redis = new Redis(redisUrl);
const store = createConfigStore({ databaseUrl, redisUrl });
const pool = new pg.Pool({ connectionString: databaseUrl });
const queue = createDeliveryQueue(redis);
const throttle = createThrottle({ redis, ...throttleConfigFromEnv(), enqueue: (n) => queue.enqueue(n) });
const hooks = createDedupHooks({ redis, repo: createPgAlertRepo(pool), throttle });
const engine = createEngine({ redis, store, hooks });
await engine.start();
throttle.start();
console.log("engine started");

const shutdown = async () => {
  await engine.stop();
  await throttle.stop();
  await store.close();
  await pool.end();
  redis.disconnect();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
