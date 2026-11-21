import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createConfigStore, migrate, type ConfigStore } from "@alerting/config";
import type { Source } from "@alerting/shared";
import {
  createParserCache,
  handleHttpIngest,
  migrateIngest,
  startIngest,
  startParseWorker,
  type IngestRunner,
  type ParseWorker,
} from "../src/index.js";

const enabled = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!enabled)(
  "ingest pipeline e2e (needs DATABASE_URL and REDIS_URL)",
  () => {
    const run = `e2e${Date.now()}`;
    const ids = {
      http: `${run}-http`,
      file: `${run}-file`,
      stream: `${run}-stream`,
    };
    const srcStream = `test:${run}:src`;
    const dir = mkdtempSync(join(tmpdir(), "ingest-e2e-"));
    const file = join(dir, "app.log");
    let pool: pg.Pool;
    let redis: Redis;
    let store: ConfigStore;
    let runner: IngestRunner;
    let worker: ParseWorker;
    let closeParsers: () => void;

    async function waitRow(
      sourceId: string,
      since: number,
    ): Promise<{ raw: unknown; parsed: unknown } | undefined> {
      const deadline = since + 1000;
      while (Date.now() < deadline) {
        const r = await pool.query(
          "SELECT raw, parsed FROM events WHERE source_id = $1 ORDER BY created_at LIMIT 1",
          [sourceId],
        );
        if (r.rows[0]) return r.rows[0] as { raw: unknown; parsed: unknown };
        await sleep(50);
      }
      return undefined;
    }

    beforeAll(async () => {
      pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
      redis = new Redis(process.env.REDIS_URL as string, {
        maxRetriesPerRequest: null,
      });
      await migrate(pool);
      await migrateIngest(pool);
      store = createConfigStore({ pool, redis });
      writeFileSync(file, "");
      const sources: Source[] = [
        {
          id: ids.http,
          name: "h",
          enabled: true,
          type: "http",
          config: {},
          parser: { type: "json" },
        },
        {
          id: ids.file,
          name: "f",
          enabled: true,
          type: "file_tail",
          config: { path: file },
          parser: { type: "json" },
        },
        {
          id: ids.stream,
          name: "s",
          enabled: true,
          type: "redis_stream",
          config: { stream: srcStream, consumerGroup: `${run}-g` },
          parser: { type: "logfmt" },
        },
      ];
      for (const s of sources) await store.upsert("source", s);
      const parsers = await createParserCache(store);
      closeParsers = () => parsers.close();
      worker = startParseWorker({
        redis,
        pool,
        getParser: (id) => parsers.get(id),
        blockMs: 200,
      });
      runner = await startIngest({
        store,
        redis,
        redisUrl: process.env.REDIS_URL,
      });
      await runner.settled();
      await sleep(300); // let file watcher / consumer group settle
    });

    afterAll(async () => {
      await runner?.stop();
      await worker?.stop();
      closeParsers?.();
      for (const id of Object.values(ids)) {
        await store?.delete("source", id);
        await pool?.query("DELETE FROM events WHERE source_id = $1", [id]);
      }
      await redis?.del(srcStream);
      await store?.close();
      await Promise.allSettled([redis?.quit(), pool?.end()]);
    });

    it("http -> event row within 1s", async () => {
      const t = Date.now();
      expect(
        await handleHttpIngest(ids.http, '{"level":"error","msg":"boom"}'),
      ).toEqual({ accepted: 1 });
      const row = await waitRow(ids.http, t);
      expect(row?.parsed).toEqual({ level: "error", msg: "boom" });
    });

    it("file_tail -> event row within 1s", async () => {
      const t = Date.now();
      appendFileSync(file, '{"from":"file"}\n');
      expect((await waitRow(ids.file, t))?.parsed).toEqual({ from: "file" });
    });

    it("redis_stream -> event row within 1s", async () => {
      const t = Date.now();
      await redis.xadd(srcStream, "*", "data", "level=warn msg=hi");
      expect((await waitRow(ids.stream, t))?.parsed).toEqual({
        level: "warn",
        msg: "hi",
      });
    });

    it("unparseable line with json parser -> {raw}", async () => {
      await pool.query("DELETE FROM events WHERE source_id = $1", [ids.http]);
      const t = Date.now();
      await handleHttpIngest(ids.http, "this is not json");
      expect((await waitRow(ids.http, t))?.parsed).toEqual({
        raw: "this is not json",
      });
    });
  },
);
