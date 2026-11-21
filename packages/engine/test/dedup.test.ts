import { afterAll, beforeEach, describe, expect, it } from "vitest";
import RedisMock from "ioredis-mock";
import { Redis } from "ioredis";
import pg from "pg";
import type { Alert, Event, Notification, Person, Rule } from "@alerting/shared";
import {
  createDedupHooks,
  createMemoryAlertRepo,
  createPgAlertRepo,
  createStaticDirectory,
  createStaticRuleCache,
  createThrottle,
  processEvent,
  type AlertRepo,
  type EngineHooks,
} from "../src/index.js";

const quiet = { error() {} };
const people: Person[] = ["a", "b"].map((id) => ({
  id,
  name: id,
  role: "dev",
  canCreateRules: false,
  ntfyTopic: `t-${id}`,
}));
const directory = createStaticDirectory({ people });
const mkRule = (id: string): Rule => ({
  id,
  name: id,
  enabled: true,
  when: "",
  who: [{ recipients: [{ type: "person", id: "a" }, { type: "person", id: "b" }] }],
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
    common: { severity: "warning", title: "Boom", source: "svc", environment: "prod", dedupKey: "k1", ...common },
  }) as unknown as Event;

class Harness {
  sent: Notification[] = [];
  published: Array<{ alertId: string; kind: string }> = [];
  constructor(
    readonly hooks: EngineHooks,
    readonly rule: Rule,
  ) {}
  async feed(event: Event, entryId = event.id) {
    return processEvent(event, {
      rules: createStaticRuleCache([this.rule], quiet).rules(),
      directory,
      enqueue: (n) => void this.sent.push(n),
      publishAlert: (ae) => void this.published.push({ alertId: ae.alertId, kind: ae.kind }),
      hooks: this.hooks,
      logger: quiet,
      entryId,
    });
  }
}

function suite(name: string, make: () => Promise<{ redis: Redis; repo: AlertRepo; done(): Promise<void> }>) {
  describe(name, () => {
    let redis: Redis;
    let repo: AlertRepo;
    let done: () => Promise<void>;
    let rule: Rule;
    let n = 0;
    let h: Harness;
    beforeEach(async () => {
      if (done) await done();
      ({ redis, repo, done } = await make());
      rule = mkRule(`r-${Date.now()}-${n++}`);
      h = new Harness(createDedupHooks({ redis, repo }), rule);
    });
    afterAll(async () => {
      if (done) await done();
    });

    it("folds duplicates into one alert without new notifications", async () => {
      const r1 = await h.feed(mkEvent("e1"));
      const r2 = await h.feed(mkEvent("e2"));
      const r3 = await h.feed(mkEvent("e3"));
      expect(r2.alerts[0]!.id).toBe(r1.alerts[0]!.id);
      expect(r3.alerts[0]!.count).toBe(3);
      const stored = (await repo.get(r1.alerts[0]!.id))!;
      expect(stored.count).toBe(3);
      expect(r1.notifications.length).toBeGreaterThan(0);
      expect(r2.notifications).toHaveLength(0);
      expect(r3.notifications).toHaveLength(0);
      expect(h.published.map((p) => p.kind)).toEqual(["created", "updated", "updated"]);
    });

    it("separates different dedup keys", async () => {
      const a = await h.feed(mkEvent("e1"));
      const b = await h.feed(mkEvent("e2", { dedupKey: "k2" }));
      expect(b.alerts[0]!.id).not.toBe(a.alerts[0]!.id);
      expect(b.alerts[0]!.count).toBe(1);
    });

    it("renotifies with a distinct id when severity increases, never lowers it", async () => {
      const first = await h.feed(mkEvent("e1"));
      const up = await h.feed(mkEvent("e2", { severity: "critical" }));
      const down = await h.feed(mkEvent("e3", { severity: "info" }));
      expect(up.alerts[0]!.severity).toBe("critical");
      expect(up.alerts[0]!.id).toBe(first.alerts[0]!.id);
      expect(up.notifications.length).toBeGreaterThan(0);
      const ids = new Set([...first.notifications, ...up.notifications].map((x) => x.id));
      expect(ids.size).toBe(first.notifications.length + up.notifications.length);
      expect(down.notifications).toHaveLength(0);
      expect(down.alerts[0]!.severity).toBe("critical");
      expect(h.published.map((p) => p.kind)).toEqual(["created", "severity_increased", "updated"]);
    });

    it("opens a new alert after auto-resolve and handles acknowledged state", async () => {
      const first = await h.feed(mkEvent("e1"));
      const id = first.alerts[0]!.id;
      const stored = (await repo.get(id))!;
      await repo.upsert({ ...stored, state: "acknowledged" } as Alert);
      const dup = await h.feed(mkEvent("e2"));
      expect(dup.alerts[0]!.id).toBe(id);
      expect(dup.alerts[0]!.state).toBe("acknowledged");

      h.sent.length = 0;
      const res = await h.feed(mkEvent("e3", { sourceStatus: "resolved" }));
      expect(res.alerts[0]!.id).toBe(id);
      expect(res.alerts[0]!.state).toBe("resolved");
      expect(res.notifications).toHaveLength(0);
      expect(h.sent).toHaveLength(0);
      expect(h.published.at(-1)).toEqual({ alertId: id, kind: "resolved" });
      expect(((await repo.get(id))!).state).toBe("resolved");

      const again = await h.feed(mkEvent("e4"));
      expect(again.alerts[0]!.id).not.toBe(id);
      expect(again.alerts[0]!.count).toBe(1);
      expect(again.notifications.length).toBeGreaterThan(0);
    });

    it("accepts the legacy `status` field for resolved", async () => {
      const first = await h.feed(mkEvent("e1"));
      const res = await h.feed(mkEvent("e2", { status: "resolved" }));
      expect(res.alerts[0]!.id).toBe(first.alerts[0]!.id);
      expect(res.alerts[0]!.state).toBe("resolved");
    });

    it("opens a new alert when the previous one was resolved elsewhere (UI)", async () => {
      const first = await h.feed(mkEvent("e1"));
      const stored = (await repo.get(first.alerts[0]!.id))!;
      await repo.upsert({ ...stored, state: "resolved" } as Alert);
      const next = await h.feed(mkEvent("e2"));
      expect(next.alerts[0]!.id).not.toBe(first.alerts[0]!.id);
      expect(next.alerts[0]!.count).toBe(1);
      expect(next.notifications.length).toBeGreaterThan(0);
    });

    it("a resolved event with no open alert creates nothing", async () => {
      const res = await h.feed(mkEvent("e1", { sourceStatus: "resolved" }));
      expect(res.alerts).toHaveLength(0);
      expect(res.notifications).toHaveLength(0);
      expect(h.sent).toHaveLength(0);
      expect(h.published).toHaveLength(0);
      // also after the alert was already resolved
      await h.feed(mkEvent("e2"));
      await h.feed(mkEvent("e3", { sourceStatus: "resolved" }));
      h.published.length = 0;
      const again = await h.feed(mkEvent("e4", { sourceStatus: "resolved" }));
      expect(again.alerts).toHaveLength(0);
      expect(h.published).toHaveLength(0);
    });

    it("does not double count a redelivered event and replays its outcome", async () => {
      const first = await h.feed(mkEvent("e1"), "1-0");
      await h.feed(mkEvent("e2"), "2-0");
      const redelivered = await h.feed(mkEvent("e2"), "2-0");
      expect(redelivered.alerts[0]!.count).toBe(2);
      const again = await h.feed(mkEvent("e1"), "1-0");
      // the creating event replays with its notification (ids are deterministic, so re-enqueue is idempotent)
      expect(again.alerts[0]!.id).toBe(first.alerts[0]!.id);
      expect(again.notifications.map((x) => x.id)).toEqual(first.notifications.map((x) => x.id));
      expect((await repo.get(first.alerts[0]!.id))!.count).toBe(2);
    });

    it("500 identical events in under a minute -> one alert, count 500, one notification per recipient", async () => {
      const t0 = Date.now();
      for (let i = 0; i < 500; i++) await h.feed(mkEvent(`bulk-${i}`));
      expect(Date.now() - t0).toBeLessThan(60_000);
      const alertIds = new Set(h.published.map((p) => p.alertId));
      expect(alertIds.size).toBe(1);
      expect((await repo.get([...alertIds][0]!))!.count).toBe(500);
      const per = new Map<string, number>();
      for (const x of h.sent) per.set(x.recipientId, (per.get(x.recipientId) ?? 0) + 1);
      for (const [, c] of per) expect(c).toBeLessThanOrEqual(2); // ui + ntfy? only one of each at most
      const perChannel = new Map<string, number>();
      for (const x of h.sent) perChannel.set(`${x.recipientId}/${x.channel}`, (perChannel.get(`${x.recipientId}/${x.channel}`) ?? 0) + 1);
      for (const [, c] of perChannel) expect(c).toBe(1);
    });

    it("applies the throttle through beforeEnqueue", async () => {
      const sent: Notification[] = [];
      const throttle = createThrottle({ redis, max: 1, windowMs: 60_000, enqueue: (x) => void sent.push(x) });
      const hh = new Harness(createDedupHooks({ redis, repo, throttle }), rule);
      // two different alerts to the same ntfy recipients; the second is buffered
      const r1 = await hh.feed(mkEvent("e1", { severity: "error" }));
      const r2 = await hh.feed(mkEvent("e2", { severity: "error", dedupKey: "other" }));
      expect(r1.notifications.some((x) => x.channel === "ntfy")).toBe(true);
      expect(r2.notifications.every((x) => x.channel === "ui")).toBe(true);
      expect(await throttle.flushDue(Date.now() + 120_000)).toBe(2);
      expect(sent.every((x) => x.digestAlertIds?.length === 1)).toBe(true);
    });
  });
}

suite("dedup (memory repo, mock redis)", async () => {
  const redis = new RedisMock() as unknown as Redis;
  await redis.flushall();
  return { redis, repo: createMemoryAlertRepo(), done: async () => void redis.disconnect() };
});

const REDIS_URL = process.env.REDIS_URL;
const DATABASE_URL = process.env.DATABASE_URL;
const DDL =
  "CREATE TABLE IF NOT EXISTS alerts (id text PRIMARY KEY, rule_id text NOT NULL, dedup_key text NOT NULL, state text NOT NULL, last_seen timestamptz NOT NULL, data jsonb NOT NULL)";

describe.skipIf(!REDIS_URL || !DATABASE_URL)("dedup (real redis + postgres)", () => {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const redises: Redis[] = [];
  const ruleIds: string[] = [];
  const mk = () => {
    const r = new Redis(REDIS_URL!);
    redises.push(r);
    return r;
  };
  suite("pg", async () => {
    await pool.query(DDL);
    const redis = mk();
    return { redis, repo: createPgAlertRepo(pool), done: async () => undefined };
  });

  it("two engine instances processing interleaved events concurrently count exactly", async () => {
    await pool.query(DDL);
    const repo = createPgAlertRepo(pool);
    const rule = mkRule(`conc-${Date.now()}`);
    ruleIds.push(rule.id);
    const h1 = new Harness(createDedupHooks({ redis: mk(), repo }), rule);
    const h2 = new Harness(createDedupHooks({ redis: mk(), repo }), rule);
    const total = 200;
    await Promise.all(
      Array.from({ length: total }, (_, i) => (i % 2 === 0 ? h1 : h2).feed(mkEvent(`c-${i}`))),
    );
    const ids = new Set([...h1.published, ...h2.published].map((p) => p.alertId));
    expect(ids.size).toBe(1);
    expect((await repo.get([...ids][0]!))!.count).toBe(total);
    const perChannel = new Map<string, number>();
    for (const x of [...h1.sent, ...h2.sent]) perChannel.set(`${x.recipientId}/${x.channel}`, (perChannel.get(`${x.recipientId}/${x.channel}`) ?? 0) + 1);
    for (const [, c] of perChannel) expect(c).toBe(1);
  });

  afterAll(async () => {
    await pool.query("DELETE FROM alerts WHERE rule_id LIKE 'r-%' OR rule_id LIKE 'conc-%'");
    const c = redises[0] ?? new Redis(REDIS_URL!);
    for (const pattern of ["alerting:dedup:*", "alerting:dedupseen:*", "alerting:deduplock:*", "alerting:throttle:*", "alerting:digest*"]) {
      const keys = await c.keys(pattern);
      if (keys.length) await c.del(...keys);
    }
    for (const r of redises) r.disconnect();
    if (!redises.includes(c)) c.disconnect();
    await pool.end();
  });
});
