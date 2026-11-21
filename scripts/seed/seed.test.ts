import { describe, expect, it } from "vitest";
import { createConfigStore, type Kind } from "@alerting/config";
import { loadConfigDir, seed, REPO_ROOT, KIND_ORDER } from "./seed.ts";
import type { Entity, SeedClient, SeedKind } from "./seed.ts";
import { join } from "node:path";

const data = loadConfigDir(join(REPO_ROOT, "config"));

function memoryClient(): SeedClient & { dump(): Record<string, Entity> } {
  const m = new Map<string, Entity>();
  return {
    async get(kind, id) {
      return m.get(`${kind}/${id}`);
    },
    async put(kind, id, entity) {
      m.set(`${kind}/${id}`, entity);
    },
    dump: () => Object.fromEntries([...m].sort()),
  };
}

describe("seed data", () => {
  it("covers people, groups, schemas, rules, runbooks, sources and a preference", () => {
    expect(data.person.map((p) => p.id)).toContain("anna");
    expect(data.group.length).toBe(3);
    expect(data.schema.length).toBe(3);
    expect(data.rule.length).toBe(4);
    expect(data.runbook.length).toBe(3);
    expect(data.source.map((s) => s.entity.type).sort()).toEqual(["file_tail", "http", "redis_stream"]);
    expect(data.preference.map((p) => p.id)).toEqual(["person:anna"]);
  });
});

describe("seed (in memory)", () => {
  it("is idempotent: the second run creates nothing and changes nothing", async () => {
    const c = memoryClient();
    const first = await seed(c, data);
    const snapshot = structuredClone(c.dump());
    expect(first.created).toBeGreaterThan(0);
    const second = await seed(c, data);
    expect(second.created).toBe(0);
    expect(second.kept).toBe(first.created);
    expect(c.dump()).toEqual(snapshot);
  });

  it("never overwrites an entity that exists", async () => {
    const c = memoryClient();
    await c.put("person", "anna", { id: "anna", name: "Edited" });
    await seed(c, data);
    expect((await c.get("person", "anna"))?.name).toBe("Edited");
  });
});

const STORE_KIND: Record<SeedKind, Kind> = {
  person: "person",
  group: "group",
  preference: "preference",
  schema: "schema",
  source: "source",
  rule: "rule",
  runbook: "runbook",
};

describe.skipIf(!process.env.DATABASE_URL || !process.env.REDIS_URL)("seed (real config store)", () => {
  it("second run creates 0 and leaves the store unchanged", async () => {
    const store = createConfigStore({
      databaseUrl: process.env.DATABASE_URL!,
      redisUrl: process.env.REDIS_URL!,
    });
    const client: SeedClient = {
      get: async (kind, id) => (await store.get(STORE_KIND[kind], id)) as Entity | undefined,
      put: async (kind, _id, entity) => {
        await store.upsert(STORE_KIND[kind], entity as never);
      },
    };
    const snapshot = async () =>
      Object.fromEntries(
        await Promise.all(KIND_ORDER.map(async (k) => [k, await store.list(STORE_KIND[k])] as const)),
      );
    try {
      await seed(client, data);
      const before = await snapshot();
      const again = await seed(client, data);
      expect(again.created).toBe(0);
      expect(await snapshot()).toEqual(before);
    } finally {
      await store.close();
    }
  }, 30_000);
});
