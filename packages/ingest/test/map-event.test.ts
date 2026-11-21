import pg from "pg";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createConfigStore, migrate, type ConfigStore } from "@alerting/config";
import type { Event } from "@alerting/shared";
import {
  createSchemaMapEvent,
  handleHttpIngest,
  startIngestService,
  startParseWorker,
  toRawMessage,
  startSchemaMapping,
  type IngestService,
  type SchemaMapping,
} from "../src/index.js";

const ev = { id: "1", sourceId: "s", parsed: { a: 1 }, common: {} } as unknown as Event;

describe("createSchemaMapEvent", () => {
  it("applies schemaId, common and parsed from classify", async () => {
    const map = createSchemaMapEvent({
      classify: () => ({ schemaId: "sch", parsed: { a: 2 }, common: { severity: "error" } }) as never,
    });
    const out = await map(ev);
    expect(out).toMatchObject({ id: "1", schemaId: "sch", parsed: { a: 2 }, common: { severity: "error" } });
  });

  it("returns the event unmapped and reports when classify throws", async () => {
    const errs: string[] = [];
    const map = createSchemaMapEvent(
      {
        classify: () => {
          throw new Error("boom");
        },
      },
      { onError: (e) => errs.push(e.message) },
    );
    expect(await map(ev)).toBe(ev);
    expect(errs).toEqual(["boom"]);
  });
});

describe("startSchemaMapping", () => {
  it("close() during the retry backoff resolves ready promptly", async () => {
    const errs: string[] = [];
    const store = {
      list: () => Promise.reject(new Error("db down")),
      onChange: () => Promise.resolve(() => {}),
    };
    const m = startSchemaMapping(store as never, { onError: (e) => errs.push(e.message) });
    await new Promise((r) => setTimeout(r, 50)); // first attempt failed, now in backoff
    const t = Date.now();
    m.close();
    await m.ready;
    expect(Date.now() - t).toBeLessThan(500);
    expect(errs.length).toBeGreaterThan(0);
  });
});

const enabled = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);

describe.skipIf(!enabled)("schema mapping in the ingest service (needs DATABASE_URL and REDIS_URL)", () => {
  const run = `map${Date.now()}`;
  const sourceId = `${run}-http`;
  const schemaId = `${run}-schema`;
  let pool: pg.Pool;
  let redis: Redis;
  let store: ConfigStore;
  let mapping: SchemaMapping;
  let service: IngestService;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    redis = new Redis(process.env.REDIS_URL as string, { maxRetriesPerRequest: null });
    await migrate(pool);
    store = createConfigStore({ pool, redis });
    await store.upsert("schema", {
      id: schemaId,
      name: "map test",
      match: `marker = "${run}"`,
      mapping: {
        severity: { kind: "constant", value: "critical" },
        title: { kind: "template", template: "T {{marker}}" },
        source: { kind: "constant", value: "test" },
        environment: { kind: "constant", value: "prod" },
        dedupKey: { kind: "path", path: "marker" },
        sourceStatus: { kind: "constant", value: "firing" },
        occurredAt: { kind: "path", path: "ts" },
      },
    } as never);
    await store.upsert("source", {
      id: sourceId,
      name: "h",
      enabled: true,
      type: "http",
      config: {},
      parser: { type: "json" },
    });
    mapping = startSchemaMapping(store);
    await mapping.ready;
    service = await startIngestService({
      databaseUrl: process.env.DATABASE_URL as string,
      redisUrl: process.env.REDIS_URL as string,
      mapEvent: mapping.mapEvent,
    });
  });

  afterAll(async () => {
    await service?.stop();
    mapping?.close();
    await pool?.query("DELETE FROM events WHERE source_id = $1", [sourceId]);
    await store?.delete("source", sourceId);
    await store?.delete("schema", schemaId);
    await store?.close();
    await Promise.allSettled([redis?.quit(), pool?.end()]);
  });

  // Smoke test of the full service. Other test files run parse workers on the same shared stream/group, which may consume an event
  // without mapping; so send a few events and require that at least one of ours was mapped.
  it("stores schema_id and common fields on the event row", async () => {
    let row: { schema_id: string | null; common: Record<string, unknown> } | undefined;
    for (let attempt = 0; attempt < 5 && !row; attempt++) {
      await handleHttpIngest(sourceId, JSON.stringify({ marker: run, n: attempt, ts: "2026-01-01T00:00:00Z" }));
      for (let i = 0; i < 20 && !row; i++) {
        const r = await pool.query(
          "SELECT schema_id, common FROM events WHERE source_id = $1 AND schema_id IS NOT NULL LIMIT 1",
          [sourceId],
        );
        row = r.rows[0];
        if (!row) await new Promise((r) => setTimeout(r, 100));
      }
    }
    expect(row?.schema_id).toBe(schemaId);
    expect(row?.common).toMatchObject({ severity: "critical", title: `T ${run}` });
  });

  it("maps every event (isolated stream and group)", async () => {
    const stream = `test:${run}:raw`;
    const group = `${run}-g`;
    const worker = startParseWorker({
      redis,
      pool,
      getParser: () => ({ type: "json" }),
      mapEvent: mapping.mapEvent,
      stream,
      group,
      blockMs: 200,
    });
    const strictSource = `${run}-strict`;
    try {
      for (let n = 0; n < 3; n++) {
        const msg = toRawMessage(strictSource, JSON.stringify({ marker: run, n, ts: "2026-01-01T00:00:00Z" }));
        await redis.xadd(stream, "*", "data", JSON.stringify(msg));
      }
      let rows: { schema_id: string | null; common: Record<string, unknown> }[] = [];
      for (let i = 0; i < 50 && rows.length < 3; i++) {
        rows = (await pool.query("SELECT schema_id, common FROM events WHERE source_id = $1", [strictSource])).rows;
        if (rows.length < 3) await new Promise((r) => setTimeout(r, 100));
      }
      expect(rows).toHaveLength(3);
      for (const r of rows) {
        expect(r.schema_id).toBe(schemaId);
        expect(r.common).toMatchObject({ severity: "critical", title: `T ${run}` });
      }
    } finally {
      await worker.stop();
      await pool.query("DELETE FROM events WHERE source_id = $1", [strictSource]);
      await redis.del(stream);
    }
  });
});
