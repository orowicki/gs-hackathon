import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { Redis } from "ioredis";
import { CHANNEL_CONFIG_CHANGE } from "@alerting/shared";
import type { ConfigChange } from "@alerting/shared";
import { createConfigStore, migrate } from "../src/index.js";
import type { ConfigStore } from "../src/index.js";

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;

const filter = { op: "and", args: [] } as never;
const samples = {
  source: { id: "it-src", name: "s", enabled: true, parser: { type: "json" }, type: "http", config: {} },
  schema: { id: "it-schema", name: "s", match: filter, mapping: {} },
  rule: {
    id: "it-rule", name: "r", enabled: true, when: filter, who: [],
    looks: { titleTemplate: "t", fields: [] }, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  },
  person: { id: "it-person", name: "p", role: "dev", canCreateRules: false },
  group: { id: "it-group", name: "g", memberIds: ["it-person"] },
  preference: { ownerType: "person", ownerId: "it-person", rules: [] },
  runbook: { id: "it-rb", name: "rb", type: "text", matches: filter, content: "c" },
} as const;
const ids = {
  source: "it-src", schema: "it-schema", rule: "it-rule", person: "it-person",
  group: "it-group", preference: "person:it-person", runbook: "it-rb",
} as const;

describe.skipIf(!DATABASE_URL || !REDIS_URL)("config store integration (Postgres + Redis)", () => {
  let pool: pg.Pool;
  let redis: Redis;
  let store: ConfigStore;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    redis = new Redis(REDIS_URL!);
    await Promise.all([migrate(pool), migrate(pool)]); // concurrent runs are safe
    expect(await migrate(pool)).toEqual([]); // idempotent
    store = createConfigStore({ pool, redis });
  });
  afterAll(async () => {
    await store.close();
    await redis.quit();
    await pool.end();
  });

  for (const kind of Object.keys(samples) as Array<keyof typeof samples>) {
    it(`CRUD ${kind}`, async () => {
      const entity = samples[kind] as never;
      await store.upsert(kind, entity);
      await store.upsert(kind, entity); // upsert is idempotent
      expect(await store.get(kind, ids[kind])).toEqual(entity);
      expect((await store.list(kind)).length).toBeGreaterThan(0);
      expect(await store.delete(kind, ids[kind])).toBe(true);
      expect(await store.delete(kind, ids[kind])).toBe(false);
      expect(await store.get(kind, ids[kind])).toBeUndefined();
    });
  }

  it("a second process receives the change event within 2s", async () => {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("./child-subscriber.mjs", import.meta.url)), CHANNEL_CONFIG_CHANGE],
      { env: process.env, stdio: ["ignore", "pipe", "inherit"] },
    );
    try {
      let buf = "";
      const lines: string[] = [];
      let wake: () => void = () => {};
      child.stdout.on("data", (d: Buffer) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          lines.push(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
        wake();
      });
      const waitFor = (n: number, ms: number) =>
        new Promise<void>((resolve, reject) => {
          const t = setTimeout(() => reject(new Error("timeout waiting for child")), ms);
          const check = () => {
            if (lines.length >= n) {
              clearTimeout(t);
              resolve();
            }
          };
          wake = check;
          check();
        });
      await waitFor(1, 10_000); // READY
      await store.upsert("group", samples.group as never);
      await waitFor(2, 2_000);
      expect(JSON.parse(lines[1]!) as ConfigChange).toEqual({ kind: "group", id: "it-group", op: "upsert" });
      await store.delete("group", "it-group");
    } finally {
      child.kill();
    }
  }, 15_000);
});
