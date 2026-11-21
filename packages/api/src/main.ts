import pg from "pg";
import { Redis } from "ioredis";
import { createServer } from "./server.js";

const port = Number(process.env.PORT ?? 3000);

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 1500,
});
pool.on("error", (err) => console.error("pg pool error:", err.message));

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  lazyConnect: true,
  connectTimeout: 1500,
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  retryStrategy: (times) => Math.min(times * 500, 5000),
});
redis.on("error", () => {
  /* surfaced via /health; avoid log spam */
});

const server = createServer({
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

function shutdown(): void {
  server.close();
  void pool.end().catch(() => undefined);
  redis.disconnect();
  setTimeout(() => process.exit(0), 500).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
