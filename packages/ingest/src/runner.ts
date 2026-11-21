import type { Redis } from "ioredis";
import pg from "pg";
import { Redis as RedisClient } from "ioredis";
import { createConfigStore, migrate, type ConfigStore } from "@alerting/config";
import type { ParserConfig, Source } from "@alerting/shared";
import { migrate as migrateIngest } from "./migrate.js";
import { createRawPublisher } from "./publisher.js";
import { getSourcePlugin } from "./plugins/registry.js";
import { registerBuiltinPlugins } from "./plugins/index.js";
import type { SourceHandle } from "./types.js";
import {
  consoleLogger,
  startParseWorker,
  type Logger,
  type ParseWorker,
  type WorkerOptions,
} from "./worker.js";

export interface IngestOptions {
  store: Pick<ConfigStore, "list" | "get" | "onChange">;
  redis: Redis;
  redisUrl?: string;
  logger?: Logger;
  /** Source types this runner must not start. */
  excludeTypes?: string[];
}

export interface IngestRunner {
  /** Ids of sources currently running. */
  running(): string[];
  /** Resolves once all pending reconciliations have finished (for tests). */
  settled(): Promise<void>;
  stop(): Promise<void>;
}

/** Start every enabled source and keep the running set in sync with config changes. */
export async function startIngest(opts: IngestOptions): Promise<IngestRunner> {
  const log = opts.logger ?? consoleLogger;
  registerBuiltinPlugins();
  const publisher = createRawPublisher(opts.redis);
  const active = new Map<
    string,
    { handle: SourceHandle; fingerprint: string }
  >();
  const chains = new Map<string, Promise<void>>();
  let stopped = false;

  async function stopOne(id: string): Promise<void> {
    const cur = active.get(id);
    if (!cur) return;
    active.delete(id);
    try {
      await cur.handle.stop();
    } catch (err) {
      log.error(`ingest: stopping source ${id} failed: ${String(err)}`);
    }
  }

  async function apply(id: string, source: Source | undefined): Promise<void> {
    if (stopped) return;
    if (!source || !source.enabled || opts.excludeTypes?.includes(source.type))
      return stopOne(id);
    const fingerprint = JSON.stringify([source.type, source.config]);
    if (active.get(id)?.fingerprint === fingerprint) return;
    await stopOne(id);
    const plugin = getSourcePlugin(source.type);
    if (!plugin) {
      log.error(
        `ingest: no plugin for source type "${source.type}" (source ${id})`,
      );
      return;
    }
    try {
      const handle = await plugin.start(
        source.config,
        publisher.forSource(id),
        {
          sourceId: id,
          logger: log,
          redisUrl: opts.redisUrl,
        },
      );
      if (stopped) await handle.stop();
      else active.set(id, { handle, fingerprint });
    } catch (err) {
      log.error(`ingest: source ${id} failed to start: ${String(err)}`);
    }
  }

  function reconcile(
    id: string,
    source?: () => Promise<Source | undefined>,
  ): Promise<void> {
    const prev = chains.get(id) ?? Promise.resolve();
    const next = prev
      .then(async () =>
        apply(id, await (source ? source() : opts.store.get("source", id))),
      )
      .catch((err: unknown) =>
        log.error(`ingest: reconcile ${id} failed: ${String(err)}`),
      );
    chains.set(id, next);
    return next;
  }

  // Subscribe before the initial load so no change is missed.
  const unsubscribe = await opts.store.onChange("source", (c) =>
    reconcile(c.id),
  );
  for (const s of await opts.store.list("source"))
    await reconcile(s.id, async () => s);

  return {
    running: () => [...active.keys()],
    settled: async () => void (await Promise.all([...chains.values()])),
    async stop() {
      stopped = true;
      unsubscribe();
      await Promise.all([...chains.values()]);
      await Promise.all([...active.keys()].map(stopOne));
    },
  };
}

/** Parser lookup backed by the config store, refreshed on source changes. */
export async function createParserCache(
  store: Pick<ConfigStore, "list" | "get" | "onChange">,
): Promise<{
  get(sourceId: string): Promise<ParserConfig | undefined>;
  close(): void;
}> {
  const cache = new Map<string, ParserConfig | undefined>();
  const missAt = new Map<string, number>();
  // Bumped on every change per source id; a store.get result is ignored if a newer change arrived meanwhile.
  const versions = new Map<string, number>();
  const bump = (id: string): number => {
    const v = (versions.get(id) ?? 0) + 1;
    versions.set(id, v);
    return v;
  };
  const unsubscribe = await store.onChange("source", async (c) => {
    missAt.delete(c.id);
    const v = bump(c.id);
    if (c.op === "delete") return void cache.delete(c.id);
    const s = await store.get("source", c.id);
    if (versions.get(c.id) !== v) return;
    if (s) cache.set(c.id, s.parser);
    else cache.delete(c.id);
  });
  for (const s of await store.list("source")) cache.set(s.id, s.parser);
  return {
    async get(sourceId) {
      const hit = cache.get(sourceId);
      if (hit) return hit;
      const last = missAt.get(sourceId);
      if (last !== undefined && Date.now() - last < 5000) return undefined;
      const v = versions.get(sourceId) ?? 0;
      const s = await store.get("source", sourceId);
      if (s) {
        if ((versions.get(sourceId) ?? 0) === v) cache.set(sourceId, s.parser);
        return s.parser;
      }
      missAt.set(sourceId, Date.now());
      return undefined;
    },
    close: unsubscribe,
  };
}

export interface IngestService {
  stop(): Promise<void>;
}

export interface IngestServiceOptions {
  /** Start the sources runner (default true). When false only the parse worker runs. */
  runSources?: boolean;
  /** Restrict the runner to these source types (e.g. exclude "http" when no HTTP route lives in this process). */
  excludeTypes?: string[];
  databaseUrl: string;
  redisUrl: string;
  logger?: Logger;
  mapEvent?: WorkerOptions["mapEvent"];
}

/** Migrations + sources runner + parse worker, with their own Postgres/Redis connections. */
export async function startIngestService(
  opts: IngestServiceOptions,
): Promise<IngestService> {
  const log = opts.logger ?? consoleLogger;
  const pool = new pg.Pool({ connectionString: opts.databaseUrl });
  pool.on("error", (err) => log.error(`ingest: pg pool error: ${err.message}`));
  const redis = new RedisClient(opts.redisUrl, { maxRetriesPerRequest: null });
  redis.on("error", (err) => log.error(`ingest: redis error: ${err.message}`));
  await migrate(pool);
  await migrateIngest(pool);
  const store = createConfigStore({ pool, redis });
  const parsers = await createParserCache(store);
  const worker: ParseWorker = startParseWorker({
    redis,
    pool,
    getParser: (id) => parsers.get(id),
    mapEvent: opts.mapEvent,
    logger: log,
  });
  const runner =
    opts.runSources === false
      ? undefined
      : await startIngest({
          store,
          redis,
          redisUrl: opts.redisUrl,
          logger: log,
          excludeTypes: opts.excludeTypes,
        });
  log.info(
    `ingest: started (${runner ? `${runner.running().length} sources` : "parse worker only"})`,
  );
  return {
    async stop() {
      await runner?.stop();
      await worker.stop();
      parsers.close();
      await store.close();
      await Promise.allSettled([redis.quit(), pool.end()]);
    },
  };
}
