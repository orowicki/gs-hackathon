import { Redis } from "ioredis";
import { createConfigStore } from "@alerting/config";
import { createEngine } from "./index.js";

const redisUrl = process.env.REDIS_URL;
const databaseUrl = process.env.DATABASE_URL;
if (!redisUrl || !databaseUrl) {
  console.error("engine: REDIS_URL and DATABASE_URL are required");
  process.exit(1);
}
const redis = new Redis(redisUrl);
const store = createConfigStore({ databaseUrl, redisUrl });
const engine = createEngine({ redis, store });
await engine.start();
console.log("engine started");

const shutdown = async () => {
  await engine.stop();
  await store.close();
  redis.disconnect();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
