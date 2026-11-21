import { afterAll, describe, expect, it } from "vitest";
import RedisMock from "ioredis-mock";
import { Redis } from "ioredis";
import pg from "pg";
import type { ConfigStore } from "@alerting/config";
import type { Event, Notification, Person, Rule } from "@alerting/shared";
import { GROUP_ENGINE, STREAM_EVENTS } from "@alerting/shared";
import {
  createDedupHooks,
  createEngine,
  createMemoryAlertRepo,
  createPgAlertRepo,
  createStaticDirectory,
  createStaticRuleCache,
  processEvent,
  type AlertRepo,
} from "../src/index.js";

const quiet = { error() {} };
const people: Person[] = [
  { id: "a", name: "a", role: "dev", canCreateRules: false },
];
const directory = createStaticDirectory({ people });
const mkRule = (id: string): Rule => ({
  id,
  name: id,
  enabled: true,
  when: "",
  who: [{ recipients: [{ type: "person", id: "a" }] }],
  looks: { titleTemplate: "{{title}}", fields: [] },
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
});
const mkEvent = (id: string, common: Record<string, unknown> = {}): Event =>
  ({
    id,
    sourceId: "s1",
    receivedAt: "2026-01-01T00:00:00Z",
    raw: "",
    parsed: {},
    schemaId: null,
    common: {
      severity: "warning",
      title: "Boom",
      source: "svc",
      environment: "prod",
      dedupKey: "k1",
      ...common,
    },
  }) as unknown as Event;

function worker(redis: Redis, repo: AlertRepo, rule: Rule) {
  const hooks = createDedupHooks({ redis, repo });
  const sent: Notification[] = [];
  const published: Array<{ alertId: string; kind: string }> = [];
  return {
    sent,
    published,
    feed: (event: Event, entryId = event.id) =>
      processEvent(event, {
        rules: createStaticRuleCache([rule], quiet).rules(),
        directory,
        enqueue: (n) => void sent.push(n),
        publishAlert: (ae) =>
          void published.push({ alertId: ae.alertId, kind: ae.kind }),
        hooks,
        logger: quiet,
        entryId,
      }),
  };
}

function suite(
  name: string,
  make: () => Promise<{
    redis: () => Redis;
    repo: AlertRepo;
    open(rule: string): Promise<number>;
  }>,
) {
  describe(name, () => {
    it("400 concurrent events, one key, one worker: one alert, exact count, one created", async () => {
      const { redis, repo } = await make();
      const rule = mkRule(`cc1-${Date.now()}`);
      const w = worker(redis(), repo, rule);
      await Promise.all(
        Array.from({ length: 400 }, (_, i) =>
          w.feed(mkEvent(`e${i}`), `${i + 1}-0`),
        ),
      );
      const ids = new Set(w.published.map((p) => p.alertId));
      expect(ids.size).toBe(1);
      expect((await repo.get([...ids][0]!))!.count).toBe(400);
      expect(w.published.filter((p) => p.kind === "created")).toHaveLength(1);
      expect(w.sent).toHaveLength(1);
    });

    it("two workers sharing repo+redis: exact count, exactly one created, severity raise notified once", async () => {
      const { redis, repo, open } = await make();
      const rule = mkRule(`cc2-${Date.now()}`);
      const w1 = worker(redis(), repo, rule);
      const w2 = worker(redis(), repo, rule);
      const total = 300;
      await Promise.all(
        Array.from({ length: total }, (_, i) =>
          (i % 2 ? w1 : w2).feed(
            mkEvent(`e${i}`, i === 150 ? { severity: "critical" } : {}),
            `${i + 1}-0`,
          ),
        ),
      );
      const all = [...w1.published, ...w2.published];
      expect(new Set(all.map((p) => p.alertId)).size).toBe(1);
      expect((await repo.get(all[0]!.alertId))!.count).toBe(total);
      expect(all.filter((p) => p.kind === "created")).toHaveLength(1);
      expect(all.filter((p) => p.kind === "severity_increased").length).toBe(1);
      expect((await repo.get(all[0]!.alertId))!.severity).toBe("critical");
      expect(await open(rule.id)).toBe(1);
    });

    it("redelivered entries across workers are not counted twice", async () => {
      const { redis, repo } = await make();
      const rule = mkRule(`cc3-${Date.now()}`);
      const w1 = worker(redis(), repo, rule);
      const w2 = worker(redis(), repo, rule);
      const evs = Array.from({ length: 50 }, (_, i) => mkEvent(`e${i}`));
      for (const [i, e] of evs.entries()) await w1.feed(e, `${i + 1}-0`);
      await Promise.all(evs.map((e, i) => w2.feed(e, `${i + 1}-0`)));
      const id = w1.published[0]!.alertId;
      expect((await repo.get(id))!.count).toBe(50);
    });

    it("two handlers racing on the same entry apply it exactly once", async () => {
      const { redis, repo } = await make();
      const rule = mkRule(`cc5-${Date.now()}`);
      const first = (
        await worker(redis(), repo, rule).feed(mkEvent("first"), "1-0")
      ).alerts[0]!.id;
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let started = 0;
      const slow: AlertRepo = {
        ...repo,
        upsertOpen: async (a) => {
          started++;
          await gate;
          return repo.upsertOpen(a);
        },
      };
      const a = worker(redis(), slow, rule);
      const b = worker(redis(), slow, rule);
      const ev = mkEvent("dup");
      const pa = a.feed(ev, "2-0");
      await new Promise((r) => setTimeout(r, 30));
      const rb = await b.feed(ev, "2-0");
      // the second handler sees the pending claim and fails, so its entry stays pending
      expect(rb.failed).toHaveLength(1);
      release();
      expect((await pa).failed).toHaveLength(0);
      expect((await repo.get(first))!.count).toBe(2);
      // after completion a redelivery replays instead of counting
      expect((await b.feed(ev, "2-0")).failed).toHaveLength(0);
      expect((await repo.get(first))!.count).toBe(2);
      expect(started).toBe(1);
    });

    it("different keys stay separate under concurrency", async () => {
      const { redis, repo } = await make();
      const rule = mkRule(`cc4-${Date.now()}`);
      const w = worker(redis(), repo, rule);
      await Promise.all(
        Array.from({ length: 90 }, (_, i) =>
          w.feed(mkEvent(`e${i}`, { dedupKey: `k${i % 3}` }), `${i + 1}-0`),
        ),
      );
      const ids = [...new Set(w.published.map((p) => p.alertId))];
      expect(ids).toHaveLength(3);
      for (const id of ids) expect((await repo.get(id))!.count).toBe(30);
    });
  });
}

suite("dedup concurrency (memory repo, mock redis)", async () => {
  const redis = new RedisMock() as unknown as Redis;
  await redis.flushall();
  const repo = createMemoryAlertRepo();
  return {
    redis: () => redis,
    repo,
    open: async (rid) =>
      [...repo.alerts.values()].filter(
        (a) => a.ruleId === rid && a.state !== "resolved",
      ).length,
  };
});

const REDIS_URL = process.env.REDIS_URL;
const DATABASE_URL = process.env.DATABASE_URL;

// ioredis-mock has no consumer groups, so the runner needs a real Redis
describe.skipIf(!REDIS_URL)("runner batches (real redis streams)", () => {
  it("processes a batch concurrently but same-key events in stream order, one alert with the full count", async () => {
    const redis = new Redis(REDIS_URL!);
    await redis.del(STREAM_EVENTS);
    const repo = createMemoryAlertRepo();
    const rule = mkRule(`rb-${Date.now()}`);
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
    const order: string[] = [];
    const base = createDedupHooks({ redis, repo });
    const hooks = {
      ...base,
      onAlert: async (
        a: Parameters<NonNullable<typeof base.onAlert>>[0],
        c: Parameters<NonNullable<typeof base.onAlert>>[1],
      ) => {
        order.push(c.event.id);
        await new Promise((r) => setTimeout(r, Math.random() * 5));
        return base.onAlert!(a, c);
      },
    };
    const engine = createEngine({
      redis,
      store,
      logger: quiet,
      blockMs: 20,
      hooks,
    });
    await engine.start();
    const n = 120;
    for (let i = 0; i < n; i++) {
      await redis.xadd(
        STREAM_EVENTS,
        "*",
        "data",
        JSON.stringify(mkEvent(`ev${i}`)),
      );
    }
    const end = Date.now() + 8000;
    while (
      Date.now() < end &&
      ((await redis.xpending(STREAM_EVENTS, GROUP_ENGINE))?.[0] ?? 0) !== 0
    ) {
      await new Promise((r) => setTimeout(r, 20));
    }
    while (
      Date.now() < end &&
      [...repo.alerts.values()].reduce((s, a) => s + a.count, 0) < n
    ) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await engine.stop();
    await redis.del(STREAM_EVENTS);
    redis.disconnect();
    expect(repo.alerts.size).toBe(1);
    expect([...repo.alerts.values()][0]!.count).toBe(n);
    expect(order).toEqual(Array.from({ length: n }, (_, i) => `ev${i}`));
  });
});

const DDL =
  "CREATE TABLE IF NOT EXISTS alerts (id text PRIMARY KEY, rule_id text NOT NULL, dedup_key text NOT NULL, state text NOT NULL, last_seen timestamptz NOT NULL, data jsonb NOT NULL)";

describe.skipIf(!REDIS_URL || !DATABASE_URL)(
  "dedup concurrency (real redis + postgres)",
  () => {
    const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 20 });
    const redises: Redis[] = [];
    suite("pg", async () => {
      await pool.query(DDL);
      return {
        redis: () => {
          const r = new Redis(REDIS_URL!);
          redises.push(r);
          return r;
        },
        repo: createPgAlertRepo(pool),
        open: async (rid) =>
          (
            await pool.query(
              "SELECT count(*)::int AS n FROM alerts WHERE rule_id = $1 AND state <> 'resolved'",
              [rid],
            )
          ).rows[0].n,
      };
    });
    it("the partial unique index admits one open alert per key", async () => {
      const repo = createPgAlertRepo(pool);
      const rule = mkRule(`cc-idx-${Date.now()}`);
      const w = worker(new Redis(REDIS_URL!), repo, rule);
      redises.push(new Redis(REDIS_URL!));
      await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          w.feed(mkEvent(`e${i}`), `${i + 1}-0`),
        ),
      );
      const r = await pool.query(
        "SELECT count(*)::int AS n FROM alerts WHERE rule_id = $1 AND state <> 'resolved'",
        [rule.id],
      );
      expect(r.rows[0].n).toBe(1);
    });
    afterAll(async () => {
      await pool.query("DELETE FROM alerts WHERE rule_id LIKE 'cc%'");
      for (const r of redises) r.disconnect();
      await pool.end();
    });
  },
);

describe("pg repo schema check", () => {
  it("fails fast during the cooldown, then retries after a transient error", async () => {
    let fail = true;
    let calls = 0;
    const pool = {
      query: async (q: string) => {
        calls++;
        if (fail) throw new Error("connection reset");
        if (q.includes("pg_indexes")) return { rows: [{ n: "2" }] };
        return { rows: [] };
      },
    };
    const repo = createPgAlertRepo(pool as never, {
      retryMs: 30,
      logger: { error() {} },
    });
    const alert = {
      id: "a",
      ruleId: "r",
      dedupKey: "k",
      state: "open",
      lastSeen: "2026-01-01T00:00:00Z",
    } as never;
    await expect(repo.upsertOpen(alert)).rejects.toThrow("connection reset");
    const before = calls;
    await expect(repo.upsertOpen(alert)).rejects.toThrow("connection reset");
    expect(calls).toBe(before); // no new DB round trip within the cooldown
    fail = false;
    await new Promise((r) => setTimeout(r, 60));
    await expect(repo.upsertOpen(alert)).resolves.toBeNull(); // schema check passed, empty result
  });
});
