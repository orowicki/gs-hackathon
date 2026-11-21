import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import type { Pool } from "pg";
import type { Redis } from "ioredis";
import { CHANNEL_CONFIG_CHANGE } from "@alerting/shared";
import type { ConfigChange } from "@alerting/shared";
import { createConfigStore, entityId } from "../src/index.js";

function fakes(rowCount = 1) {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const published: Array<[string, string]> = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      return { rows: [], rowCount };
    },
  } as unknown as Pool;
  const sub = Object.assign(new EventEmitter(), {
    subscribe: async () => 1,
    disconnect: () => {},
  });
  const redis = {
    publish: async (c: string, m: string) => {
      published.push([c, m]);
      return 1;
    },
    duplicate: () => sub,
  } as unknown as Redis;
  return { pool, redis, queries, published, sub };
}

describe("entityId validation", () => {
  it("rejects non-objects and missing ids", () => {
    expect(() => entityId("rule", null)).toThrow(/expected an object/);
    expect(() => entityId("rule", [])).toThrow(/expected an object/);
    expect(() => entityId("rule", { name: "x" })).toThrow(
      /non-empty string id/,
    );
    expect(() => entityId("rule", { id: "" })).toThrow(/non-empty string id/);
    expect(() => entityId("rule", { id: 3 })).toThrow(/non-empty string id/);
  });
  it("derives preference id from owner", () => {
    expect(
      entityId("preference", { ownerType: "person", ownerId: "p1", rules: [] }),
    ).toBe("person:p1");
    expect(() => entityId("preference", { ownerId: "p1" })).toThrow(
      /ownerType/,
    );
  });
});

describe("ConfigStore (fakes)", () => {
  it("upsert writes and publishes a ConfigChange", async () => {
    const f = fakes();
    const store = createConfigStore({ pool: f.pool, redis: f.redis });
    await store.upsert("group", { id: "g1", name: "G", memberIds: [] });
    expect(f.queries[0]?.params).toEqual([
      "g1",
      JSON.stringify({ id: "g1", name: "G", memberIds: [] }),
    ]);
    expect(f.published).toEqual([
      [
        CHANNEL_CONFIG_CHANGE,
        JSON.stringify({ kind: "group", id: "g1", op: "upsert" }),
      ],
    ]);
  });
  it("invalid entity throws and publishes nothing", async () => {
    const f = fakes();
    const store = createConfigStore({ pool: f.pool, redis: f.redis });
    await expect(store.upsert("person", {} as never)).rejects.toThrow(
      /non-empty string id/,
    );
    expect(f.published).toEqual([]);
  });
  it("delete publishes only when a row was removed", async () => {
    const hit = fakes(1);
    expect(
      await createConfigStore({ pool: hit.pool, redis: hit.redis }).delete(
        "rule",
        "r1",
      ),
    ).toBe(true);
    expect(JSON.parse(hit.published[0]![1])).toEqual({
      kind: "rule",
      id: "r1",
      op: "delete",
    });
    const miss = fakes(0);
    expect(
      await createConfigStore({ pool: miss.pool, redis: miss.redis }).delete(
        "rule",
        "r1",
      ),
    ).toBe(false);
    expect(miss.published).toEqual([]);
  });
  it("onChange filters by kind and unsubscribes", async () => {
    const f = fakes();
    const store = createConfigStore({ pool: f.pool, redis: f.redis });
    const rules: ConfigChange[] = [];
    const all: ConfigChange[] = [];
    const off = await store.onChange("rule", (c) => rules.push(c));
    await store.onChange("*", (c) => all.push(c));
    f.sub.emit(
      "message",
      CHANNEL_CONFIG_CHANGE,
      JSON.stringify({ kind: "rule", id: "a", op: "upsert" }),
    );
    f.sub.emit(
      "message",
      CHANNEL_CONFIG_CHANGE,
      JSON.stringify({ kind: "group", id: "b", op: "delete" }),
    );
    f.sub.emit("message", CHANNEL_CONFIG_CHANGE, "not json");
    off();
    f.sub.emit(
      "message",
      CHANNEL_CONFIG_CHANGE,
      JSON.stringify({ kind: "rule", id: "c", op: "upsert" }),
    );
    expect(rules.map((c) => c.id)).toEqual(["a"]);
    expect(all.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });
  it("a throwing or rejecting handler does not stop later handlers", async () => {
    const f = fakes();
    const store = createConfigStore({ pool: f.pool, redis: f.redis });
    const seen: string[] = [];
    await store.onChange("*", () => {
      throw new Error("boom");
    });
    await store.onChange("*", () => Promise.reject(new Error("nope")));
    await store.onChange("*", (c) => {
      seen.push(c.id);
    });
    f.sub.emit(
      "message",
      CHANNEL_CONFIG_CHANGE,
      JSON.stringify({ kind: "rule", id: "a", op: "upsert" }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual(["a"]);
  });
  it("publish failure does not fail the write", async () => {
    const f = fakes();
    (f.redis as unknown as { publish: () => Promise<never> }).publish = () =>
      Promise.reject(new Error("redis down"));
    const store = createConfigStore({ pool: f.pool, redis: f.redis });
    await expect(
      store.upsert("group", { id: "g1", name: "G", memberIds: [] }),
    ).resolves.toBeUndefined();
    expect(f.queries).toHaveLength(1);
  });
  it("concurrent onChange share one subscribe; failure is retried", async () => {
    const f = fakes();
    let calls = 0;
    let fail = true;
    f.sub.subscribe = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      if (fail) throw new Error("subscribe failed");
      return 1;
    };
    const store = createConfigStore({ pool: f.pool, redis: f.redis });
    const results = await Promise.allSettled([
      store.onChange("*", () => {}),
      store.onChange("*", () => {}),
    ]);
    expect(calls).toBe(1);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    fail = false;
    await store.onChange("*", () => {});
    expect(calls).toBe(2);
  });
  it("close is idempotent", async () => {
    const f = fakes();
    let quits = 0;
    (f.redis as unknown as { quit: () => Promise<void> }).quit = async () => {
      quits++;
    };
    const store = createConfigStore({
      pool: f.pool,
      redisUrl: undefined,
      redis: f.redis,
    });
    await store.close();
    await store.close();
    expect(quits).toBe(0); // injected redis is not owned
    const own = createConfigStore({ pool: f.pool, redis: f.redis });
    await own.close();
    await own.close();
  });
});
