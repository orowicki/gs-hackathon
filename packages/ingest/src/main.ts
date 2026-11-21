import { startIngestService } from "./runner.js";

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
if (!databaseUrl || !redisUrl) {
  console.error("ingest: DATABASE_URL and REDIS_URL are required");
  process.exit(1);
}

const service = await startIngestService({ databaseUrl, redisUrl });
let closing = false;
function shutdown(): void {
  if (closing) return;
  closing = true;
  setTimeout(() => process.exit(0), 5000).unref();
  void service.stop().finally(() => process.exit(0));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
