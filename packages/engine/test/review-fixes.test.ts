import { describe, expect, it } from "vitest";
import type { Alert } from "@alerting/shared";
import type { Redis } from "ioredis";
import type { ConfigStore } from "@alerting/config";
import type { Event, Person, Rule } from "@alerting/shared";
import { createEngine, createPgAlertRepo, type EngineHooks } from "../src/index.js";

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

describe("reclaim and in-flight entries", () => {
  it("deliveries counted while an entry was in flight here do not make it give up", async () => {
    const redis = fakeRedis();
    let attempts = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const hooks: EngineHooks = {
      async onAlert() {
        attempts++;
        if (attempts === 1) {
          await gate;
          throw new Error("transient");
        }
      },
    };
    const engine = createEngine({
      redis,
      store,
      logger: quiet,
      blockMs: 2,
      reclaimEveryMs: 5,
      reclaimMinIdleMs: 0,
      maxDeliveries: 3,
      hooks,
    });
    await engine.start();
    redis.addEntry("1-0", mkEvent("slow", "k"));
    await until(() => attempts === 1);
    // several reclaim rounds bump the delivery count while the first attempt is still running
    await until(() => (redis.pending.get("1-0")?.deliveries ?? 0) >= 6);
    release();
    await until(() => redis.acked.includes("1-0"));
    await engine.stop();
    expect(attempts).toBe(2);
  });
});

const mkAlert = (id: string, key: string): Alert =>
  ({ id, ruleId: "r", dedupKey: key, state: "open", lastSeen: "2026-01-01T00:00:00Z", severity: "info", common: {} }) as unknown as Alert;

function mockPool(onInsert: (q: string) => Promise<{ rows: unknown[] }>) {
  let active = 0;
  const stats = { batch: 0, single: 0, maxConcurrentSingles: 0 };
  const pool = {
    async query(q: string) {
      if (q.includes("pg_indexes")) return { rows: [{ n: "2" }] };
      if (q.includes("unnest")) stats.batch++;
      else {
        stats.single++;
        active++;
        stats.maxConcurrentSingles = Math.max(stats.maxConcurrentSingles, active);
      }
      try {
        return await onInsert(q);
      } finally {
        if (!q.includes("unnest")) active--;
      }
    },
  };
  return { pool, stats };
}

describe("pg repo batch failure handling (mock pool)", () => {
  it("a connection or timeout error fails the whole batch without per-item retries", async () => {
    const { pool, stats } = mockPool(async () => {
      throw Object.assign(new Error("Query read timeout"), {});
    });
    const repo = createPgAlertRepo(pool as never);
    const res = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => repo.upsertOpen(mkAlert(`a${i}`, `k${i}`))));
    expect(res.every((r) => r.status === "rejected")).toBe(true);
    expect(stats.single).toBe(0);
  });

  it("a data error retries items one by one with bounded concurrency", async () => {
    const { pool, stats } = mockPool(async (q) => {
      if (q.includes("unnest")) throw Object.assign(new Error("invalid input syntax"), { code: "22007" });
      await new Promise((r) => setTimeout(r, 2));
      return { rows: [] };
    });
    const repo = createPgAlertRepo(pool as never, { maxInFlight: 3 });
    const res = await Promise.all(Array.from({ length: 40 }, (_, i) => repo.upsertOpen(mkAlert(`a${i}`, `k${i}`))));
    expect(res.every((r) => r === null)).toBe(true);
    expect(stats.single).toBe(40);
    expect(stats.maxConcurrentSingles).toBeLessThanOrEqual(3);
  });
});
