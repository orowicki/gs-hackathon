import { hostname } from "node:os";
import pg from "pg";
import { Redis } from "ioredis";
import { createConfigStore, migrate } from "@alerting/config";
import { createDeliveryQueue } from "@alerting/delivery";
import { startRunbookWorker } from "@alerting/runbooks";
import { createRunbookRuntime } from "./runbooks-runtime.js";

export interface RunbookWorkerProcessOptions {
  redisUrl: string;
  databaseUrl: string;
  /** Consumer group on the alerts stream (default "runbooks"; each alert's runbooks run once per group). */
  group?: string;
  /** Unique per instance (default: hostname, stable across restarts so pending entries are re-read). */
  consumer?: string;
  onError?: (err: unknown) => void;
}

/** Starts a runbook worker process: config store, runbook runner and the alerts stream consumer. */
export async function startRunbookWorkerProcess(o: RunbookWorkerProcessOptions): Promise<{ close(): Promise<void> }> {
  const onError = o.onError ?? ((err: unknown) => console.error("runbook worker:", err));
  const redis = new Redis(o.redisUrl);
  redis.on("error", () => {
    /* reconnects automatically */
  });
  const pool = new pg.Pool({ connectionString: o.databaseUrl, statement_timeout: 10_000 });
  pool.on("error", (err) => console.error(`runbook worker: postgres pool error: ${err.message}`));
  const store = createConfigStore({ pool, redis });
  // Enqueue only: the API process owns the channels and the delivery worker.
  const queue = createDeliveryQueue(redis);
  let worker: { close(): Promise<void> } | undefined;
  const runtime = createRunbookRuntime({ pool, redis, config: store, enqueue: (n) => queue.enqueue(n), onError });
  try {
    await migrate(pool);
    await runtime.ready;
    const registry = runtime.registry!;
    await registry.ready;
    worker = startRunbookWorker({
      redis,
      registry,
      runner: runtime.runner,
      loadAlert: runtime.loadAlert,
      loadEvent: runtime.loadEvent,
      group: o.group,
      consumer: o.consumer ?? hostname(),
      onError,
    });
  } catch (err) {
    await runtime.close().catch(() => undefined);
    await store.close().catch(() => undefined);
    await pool.end().catch(() => undefined);
    redis.disconnect();
    throw err;
  }
  return {
    async close() {
      await worker?.close();
      await runtime.close();
      await store.close();
      await pool.end();
      redis.disconnect();
    },
  };
}
