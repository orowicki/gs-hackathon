import { startRunbookWorkerProcess } from "./runbook-worker-process.js";

const redisUrl = process.env.REDIS_URL;
const databaseUrl = process.env.DATABASE_URL;
if (!redisUrl || !databaseUrl) {
  console.error("runbook worker: REDIS_URL and DATABASE_URL are required");
  process.exit(1);
}
const worker = await startRunbookWorkerProcess({ redisUrl, databaseUrl });
console.log("runbook worker started");

const shutdown = async () => {
  setTimeout(() => process.exit(0), 3000).unref();
  await worker.close().catch(() => undefined);
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
