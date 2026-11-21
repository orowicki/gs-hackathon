import pg from "pg";
import { Redis } from "ioredis";
import { startIngestService, type IngestService } from "@alerting/ingest";
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
  server.close();
  server.closeAllConnections?.();
  void Promise.allSettled([ingest?.stop(), pool.end(), redis.quit()]).then(() => process.exit(0));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
