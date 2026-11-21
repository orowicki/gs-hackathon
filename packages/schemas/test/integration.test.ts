import { describe, expect, it } from "vitest";
import pg from "pg";
import { Redis } from "ioredis";
import { createConfigStore, migrate } from "@alerting/config";
import { createSchemaRegistry } from "../src/index.js";

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;

describe.skipIf(!DATABASE_URL || !REDIS_URL)(
  "schema registry (Postgres + Redis)",
  () => {
    it("reloads after a store upsert and delete", async () => {
      const pool = new pg.Pool({ connectionString: DATABASE_URL });
      const redis = new Redis(REDIS_URL!);
      await migrate(pool);
      const store = createConfigStore({ pool, redis });
      const reg = createSchemaRegistry(store);
      try {
        await reg.ready;
        const ev = { kind: "schemas-it" };
        await store.upsert("schema", {
          id: "zz-it-schema",
          name: "it",
          match: "kind = schemas-it",
          mapping: {},
        });
        for (let i = 0; i < 50 && reg.classify(ev).schemaId === null; i++)
          await new Promise((r) => setTimeout(r, 50));
        expect(reg.classify(ev).schemaId).toBe("zz-it-schema");
        await store.delete("schema", "zz-it-schema");
        for (let i = 0; i < 50 && reg.classify(ev).schemaId !== null; i++)
          await new Promise((r) => setTimeout(r, 50));
        expect(reg.classify(ev).schemaId).toBeNull();
      } finally {
        reg.close();
        await store.close();
        await redis.quit();
        await pool.end();
      }
    });
  },
);
