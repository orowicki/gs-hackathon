import pg from "pg";
import { Redis } from "ioredis";
import { createConfigStore, migrate } from "@alerting/config";
import { startIngestService } from "./runner.js";
import { startSchemaMapping } from "./map-event.js";

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
if (!databaseUrl || !redisUrl) {
  console.error("ingest: DATABASE_URL and REDIS_URL are required");
  process.exit(1);
}

// Own config store for the live schema registry, so events are mapped onto schemas.
const pool = new pg.Pool({ connectionString: databaseUrl });
pool.on("error", (err) => console.error("ingest: pg pool error:", err.message));
const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
redis.on("error", (err) => console.error("ingest: redis error:", err.message));
try {
  await migrate(pool);
} catch (err) {
  console.error("ingest: config migrate failed:", (err as Error).message);
}
const store = createConfigStore({ pool, redis });
const mapping = startSchemaMapping(store);
await mapping.ready;

// Standalone runs only the parse worker: the api process owns the sources runner and the http route registry.
// INGEST_RUN_SOURCES=1 additionally runs non-http sources here (do not also run them in the api process).
const runSources = process.env.INGEST_RUN_SOURCES === "1";
const service = await startIngestService({
  databaseUrl,
  redisUrl,
  runSources,
  excludeTypes: ["http"],
  mapEvent: mapping.mapEvent,
});
let closing = false;
function shutdown(): void {
  if (closing) return;
  closing = true;
  setTimeout(() => process.exit(0), 5000).unref();
  void service
    .stop()
    .then(() => {
      mapping.close();
      return store.close();
    })
    .finally(() => Promise.allSettled([redis.quit(), pool.end()]).then(() => process.exit(0)));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
