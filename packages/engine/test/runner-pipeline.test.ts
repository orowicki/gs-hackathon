import { describe, expect, it } from "vitest";
import type { Redis } from "ioredis";
import type { ConfigStore } from "@alerting/config";
import type { Event, Person, Rule } from "@alerting/shared";
import { createEngine, type EngineHooks } from "../src/index.js";

const quiet = { error() {} };
const people: Person[] = [{ id: "a", name: "a", role: "dev", canCreateRules: false }];
const rule: Rule = {
  id: "r1",
  name: "R1",
  enabled: true,
  when: "",
  who: [{ recipients: [{ type: "person", id: "a" }] }],
  looks: { titleTemplate: "{{title}}", fields: [] },
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};
const store = {
  async list(kind: string) {
    return kind === "rule" ? [rule] : kind === "person" ? people : [];
  },
  async get() {
    return undefined;
  },
  async onChange() {
    return () => {};
  },
} as unknown as ConfigStore;

const mkEvent = (id: string, dedupKey: string): Event =>
  ({
    id,
    sourceId: "s1",
    receivedAt: "2026-01-01T00:00:00Z",
    raw: "",
    parsed: {},
    schemaId: null,
    common: { severity: "info", title: id, source: "svc", environment: "prod", dedupKey },
  }) as unknown as Event;

/** Minimal stream fake: XREADGROUP hands out what was added since the last read (at most COUNT). */
function fakeRedis() {
  const acked: string[] = [];
  const xackCalls: string[][] = [];
  const pending = new Map<string, { fields: string[]; deliveries: number }>();
  let fresh: Array<[string, string[]]> = [];
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const self: Record<string, unknown> = {
    acked,
    xackCalls,
    pending,
    addEntry(id: string, event: Event) {
      fresh.push([id, ["data", JSON.stringify(event)]]);
    },
    async xgroup() {
      return "OK";
    },
    duplicate: () => self,
    async quit() {},
    disconnect() {},
    async xadd() {
      return "1-0";
    },
    async publish() {
      return 0;
    },
    async lpush() {
      return 1;
    },
    async xack(_s: string, _g: string, ...ids: string[]) {
      xackCalls.push(ids);
      for (const id of ids) {
        acked.push(id);
        pending.delete(id);
      }
      return ids.length;
    },
    async xreadgroup(...args: unknown[]) {
      const count = Number(args[args.indexOf("COUNT") + 1]);
      const batch = fresh.slice(0, count);
      fresh = fresh.slice(batch.length);
      for (const [id, fields] of batch) pending.set(id, { fields, deliveries: 1 });
      if (batch.length === 0) {
        await sleep(2);
        return null;
      }
      return [["events", batch]];
    },
    async xautoclaim() {
      const out: Array<[string, string[]]> = [];
      for (const [id, p] of pending) {
        p.deliveries++;
        out.push([id, p.fields]);
      }
      return ["0-0", out, []];
    },
    async xpending(_s: string, _g: string, id: string) {
      const p = pending.get(id);
      return p ? [[id, "c", 0, p.deliveries]] : [];
    },
  };
  return self as unknown as Redis & {
    acked: string[];
    xackCalls: string[][];
    pending: typeof pending;
    addEntry(id: string, e: Event): void;
  };
}

async function until(fn: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** Hooks that hold events whose id is in `held` until release() and record the order of calls. */
function gatedHooks() {
  const started: string[] = [];
  const finished: string[] = [];
  const held = new Set<string>();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const hooks: EngineHooks = {
    async onAlert(_a, ctx) {
      started.push(ctx.event.id);
      if (held.has(ctx.event.id)) await gate;
      finished.push(ctx.event.id);
    },
  };
  return { hooks, started, finished, held, release: () => release() };
}

describe("engine runner pipelining", () => {
  it("keeps reading and finishing other keys while one entry is slow", async () => {
    const redis = fakeRedis();
    const g = gatedHooks();
    g.held.add("slow");
    const engine = createEngine({ redis, store, logger: quiet, blockMs: 2, batchSize: 2, hooks: g.hooks });
    await engine.start();
    redis.addEntry("1-0", mkEvent("slow", "k-slow"));
    await until(() => g.started.includes("slow"));
    for (let i = 0; i < 6; i++) redis.addEntry(`${i + 2}-0`, mkEvent(`e${i}`, `k${i}`));
    await until(() => redis.acked.length === 6);
    expect(redis.acked).not.toContain("1-0");
    g.release();
    await until(() => redis.acked.includes("1-0"));
    await engine.stop();
  });

  it("keeps stream order per (rule, dedupKey) across reads", async () => {
    const redis = fakeRedis();
    const g = gatedHooks();
    g.held.add("first");
    const engine = createEngine({ redis, store, logger: quiet, blockMs: 2, batchSize: 1, hooks: g.hooks });
    await engine.start();
    redis.addEntry("1-0", mkEvent("first", "same"));
    await until(() => g.started.includes("first"));
    redis.addEntry("2-0", mkEvent("second", "same"));
    redis.addEntry("3-0", mkEvent("other", "different"));
    await until(() => redis.acked.includes("3-0"));
    await new Promise((r) => setTimeout(r, 20));
    expect(g.started).not.toContain("second");
    g.release();
    await until(() => redis.acked.includes("2-0"));
    expect(g.finished.indexOf("first")).toBeLessThan(g.finished.indexOf("second"));
    await engine.stop();
  });

  it("acks many entries with few XACK calls", async () => {
    const redis = fakeRedis();
    const engine = createEngine({ redis, store, logger: quiet, blockMs: 2 });
    await engine.start();
    for (let i = 0; i < 100; i++) redis.addEntry(`${i + 1}-0`, mkEvent(`e${i}`, `k${i}`));
    await until(() => redis.acked.length === 100);
    expect(redis.xackCalls.length).toBeLessThan(20);
    await engine.stop();
  });

  it("stop() waits for entries still in flight", async () => {
    const redis = fakeRedis();
    const g = gatedHooks();
    g.held.add("slow");
    const engine = createEngine({ redis, store, logger: quiet, blockMs: 2, hooks: g.hooks });
    await engine.start();
    redis.addEntry("1-0", mkEvent("slow", "k"));
    await until(() => g.started.includes("slow"));
    let stopped = false;
    const stopping = engine.stop().then(() => (stopped = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(stopped).toBe(false);
    g.release();
    await stopping;
    expect(redis.acked).toContain("1-0");
  });

  it("reclaim does not re-run an entry this engine is still processing", async () => {
    const redis = fakeRedis();
    const g = gatedHooks();
    g.held.add("slow");
    const engine = createEngine({
      redis,
      store,
      logger: quiet,
      blockMs: 2,
      reclaimEveryMs: 5,
      reclaimMinIdleMs: 0,
      hooks: g.hooks,
    });
    await engine.start();
    redis.addEntry("1-0", mkEvent("slow", "k"));
    await until(() => g.started.includes("slow"));
    await new Promise((r) => setTimeout(r, 50));
    g.release();
    await until(() => redis.acked.includes("1-0"));
    await engine.stop();
    expect(g.started.filter((id) => id === "slow")).toHaveLength(1);
  });
});
