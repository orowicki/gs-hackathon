import { describe, expect, it, vi } from "vitest";
import type { Redis } from "ioredis";
import type { ConfigStore } from "@alerting/config";
import type {
  ConfigChange,
  Event,
  Group,
  Notification,
  Person,
  Preference,
  Rule,
} from "@alerting/shared";
import {
  buildAlert,
  compileRule,
  createDirectory,
  createEngine,
  createRuleCache,
  createStaticDirectory,
  createStaticRuleCache,
  inQuietHours,
  matchRules,
  processEvent,
  routeAlert,
} from "../src/index.js";

const quiet = { error() {} };
const person = (id: string, extra: Partial<Person> = {}): Person => ({
  id,
  name: id,
  role: "dev",
  canCreateRules: false,
  ...extra,
});
const mkRule = (who: Rule["who"], extra: Partial<Rule> = {}): Rule => ({
  id: "r1",
  name: "R1",
  enabled: true,
  when: "",
  who,
  looks: { titleTemplate: "Hi {{title}}", fields: [] },
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  ...extra,
});
const mkEvent = (severity = "info"): Event =>
  ({
    id: "e1",
    sourceId: "s1",
    receivedAt: "2026-01-01T00:00:00Z",
    raw: "",
    parsed: {},
    schemaId: null,
    common: { severity, title: "Boom", source: "svc", environment: "prod" },
  }) as unknown as Event;
const NOON = new Date("2026-06-01T12:00:00Z");
const route = (rule: Rule, dir: ReturnType<typeof createStaticDirectory>, logger = quiet, ev = mkEvent()) => {
  const compiled = compileRule(rule);
  const alert = buildAlert(ev, compiled, NOON);
  return routeAlert({ alert, event: ev, rule: compiled, directory: dir, now: NOON, logger, publicUrl: "x" });
};
const pairs = (ns: Notification[]) => ns.map((n) => `${n.recipientId}:${n.channel}`).sort();
const pref = (ownerType: "person" | "group", ownerId: string, extra: Partial<Preference>): Preference =>
  ({ ownerType, ownerId, rules: [], ...extra }) as Preference;

describe("routing precedence", () => {
  const people = [person("a", { ntfyTopic: "ta" }), person("b")];
  const viaG = (id = "g") => mkRule([{ recipients: [{ type: "group", id }] }]);

  it("falls back to the group preference when the person's own rules do not match", () => {
    const dir = createStaticDirectory({
      people,
      groups: [{ id: "g", name: "g", memberIds: ["a"] }],
      preferences: [
        pref("person", "a", { rules: [{ when: "alert.severity >= critical", channels: ["ntfy"] }] }),
        pref("group", "g", { rules: [{ when: "", channels: ["ui", "ntfy"] }] }),
      ],
    });
    expect(pairs(route(viaG(), dir))).toEqual(["a:ntfy", "a:ui"]);
  });

  it("uses the first reaching group with a matching rule, in order", () => {
    const dir = createStaticDirectory({
      people,
      groups: [
        { id: "g1", name: "g1", memberIds: ["a"] },
        { id: "g2", name: "g2", memberIds: ["a"] },
      ],
      preferences: [
        pref("group", "g1", { rules: [{ when: "alert.severity >= critical", channels: ["ntfy"] }] }),
        pref("group", "g2", { rules: [{ when: "", channels: ["ntfy"] }] }),
      ],
    });
    const rule = mkRule([{ recipients: [{ type: "group", id: "g1" }, { type: "group", id: "g2" }] }]);
    expect(pairs(route(rule, dir))).toEqual(["a:ntfy"]);
  });

  it("uses the reaching group's quiet hours when the person has none", () => {
    const dir = createStaticDirectory({
      people,
      groups: [{ id: "g", name: "g", memberIds: ["a"] }],
      preferences: [
        pref("group", "g", {
          rules: [{ when: "", channels: ["ui", "ntfy"] }],
          quietHours: { from: "11:00", to: "13:00", timezone: "UTC" },
        }),
      ],
    });
    expect(pairs(route(viaG(), dir))).toEqual(["a:ui"]);
  });

  it("a later force row adds channels to a person already reached", () => {
    const dir = createStaticDirectory({ people });
    const rule = mkRule([
      { recipients: [{ type: "person", id: "a" }] },
      { recipients: [{ type: "person", id: "a" }], force: ["ntfy"] },
    ]);
    expect(pairs(route(rule, dir))).toEqual(["a:ntfy", "a:ui"]);
  });

  it("never emits ntfy without ntfyTopic, and logs once", () => {
    const dir = createStaticDirectory({ people: [person("nt")] });
    const err = vi.fn();
    const rule = mkRule([{ recipients: [{ type: "person", id: "nt" }], force: ["ntfy", "ui"] }]);
    expect(pairs(route(rule, dir, { error: err }))).toEqual(["nt:ui"]);
    route(rule, dir, { error: err });
    expect(err).toHaveBeenCalledTimes(1);
  });

  it("logs an invalid preference filter / quiet hours once, not per alert", () => {
    const dir = createStaticDirectory({
      people: [person("lg")],
      preferences: [
        pref("person", "lg", {
          rules: [{ when: "alert.severity >>> x", channels: ["ntfy"] }],
          quietHours: { from: "25:00", to: "26:00", timezone: "UTC" },
        }),
      ],
    });
    const err = vi.fn();
    const rule = mkRule([{ recipients: [{ type: "person", id: "lg" }] }]);
    for (let i = 0; i < 3; i++) expect(pairs(route(rule, dir, { error: err }))).toEqual(["lg:ui"]);
    expect(err).toHaveBeenCalledTimes(2);
  });
});

describe("quiet hours validation", () => {
  it("rejects malformed times", () => {
    for (const bad of ["24:00", "9:00", "12:60", "ab:cd", "12:5"]) {
      expect(() => inQuietHours({ from: bad, to: "10:00", timezone: "UTC" }, NOON)).toThrow();
    }
    expect(inQuietHours({ from: "00:00", to: "23:59", timezone: "Europe/Paris" }, NOON)).toBe(true);
  });
});

describe("matchRules logging", () => {
  it("logs a filter evaluation error once per rule version", () => {
    const bad = { rule: mkRule([], { id: "ev", updatedAt: "v-unique" }), when: { get type(): string { throw new Error("eval boom"); } }, who: [] } as never;
    const err = vi.fn();
    expect(matchRules(mkEvent(), [bad], { error: err })).toEqual([]);
    matchRules(mkEvent(), [bad], { error: err });
    expect(err).toHaveBeenCalledTimes(1);
  });
});

describe("processEvent failures and ids", () => {
  it("reports failures and yields identical ids on retry", async () => {
    const dir = createStaticDirectory({ people: [person("a")] });
    const rules = createStaticRuleCache([mkRule([{ recipients: [{ type: "person", id: "a" }] }])], quiet).rules();
    let fail = true;
    const sent: Notification[] = [];
    const deps = {
      rules,
      directory: dir,
      enqueue: (n: Notification) => {
        if (fail) throw new Error("redis down");
        sent.push(n);
      },
      logger: quiet,
      entryId: "1-0",
    };
    const first = await processEvent(mkEvent(), deps);
    expect(first.failed).toHaveLength(1);
    fail = false;
    const second = await processEvent(mkEvent(), deps);
    const third = await processEvent(mkEvent(), deps);
    expect(second.failed).toHaveLength(0);
    expect(second.alerts[0]!.id).toBe(third.alerts[0]!.id);
    expect(sent[0]!.id).toBe(sent[1]!.id);
    expect(sent[0]!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const other = await processEvent(mkEvent(), { ...deps, entryId: "2-0" });
    expect(other.alerts[0]!.id).not.toBe(second.alerts[0]!.id);
  });
});

function raceStore(initial: Rule[]) {
  const handlers: Array<(c: ConfigChange) => unknown> = [];
  let releaseList!: () => void;
  const listGate = new Promise<void>((r) => (releaseList = r));
  const getGates = new Map<string, Array<{ value: Rule | undefined; gate: Promise<void> }>>();
  const store = {
    async list() {
      const snapshot = [...initial];
      await listGate;
      return snapshot;
    },
    async get(_k: string, id: string) {
      const g = getGates.get(id)!.shift()!;
      await g.gate;
      return g.value;
    },
    async onChange(_k: string, h: (c: ConfigChange) => unknown) {
      handlers.push(h);
      return () => void handlers.splice(handlers.indexOf(h), 1);
    },
  } as unknown as ConfigStore;
  return {
    store,
    releaseList,
    emit: (c: ConfigChange) => handlers.forEach((h) => h(c)),
    queueGet(id: string, value: Rule | undefined) {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const arr = getGates.get(id) ?? [];
      arr.push({ value, gate });
      getGates.set(id, arr);
      return release;
    },
  };
}
const tick = () => new Promise((r) => setTimeout(r, 20));

describe("cache races", () => {
  it("a stale list snapshot does not resurrect an id deleted during the initial load", async () => {
    const f = raceStore([mkRule([], { id: "gone" }), mkRule([], { id: "kept" })]);
    const cache = createRuleCache(f.store, { logger: quiet });
    await tick();
    f.emit({ kind: "rule", id: "gone", op: "delete" });
    await tick();
    f.releaseList();
    await cache.ready;
    expect(cache.rules().map((c) => c.rule.id)).toEqual(["kept"]);
  });

  it("an older slow get does not overwrite a newer value", async () => {
    const v1 = mkRule([], { id: "x", name: "old", updatedAt: "1" });
    const v2 = mkRule([], { id: "x", name: "new", updatedAt: "2" });
    const f = raceStore([]);
    const cache = createRuleCache(f.store, { logger: quiet });
    f.releaseList();
    await cache.ready;
    const releaseOld = f.queueGet("x", v1);
    const releaseNew = f.queueGet("x", v2);
    f.emit({ kind: "rule", id: "x", op: "upsert" });
    f.emit({ kind: "rule", id: "x", op: "upsert" });
    releaseNew();
    await tick();
    releaseOld();
    await tick();
    expect(cache.rules().map((c) => c.rule.name)).toEqual(["new"]);
  });

  it("directory ignores a stale list snapshot after a delete event", async () => {
    const handlers: Array<{ kind: string; fn: (c: ConfigChange) => unknown }> = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const store = {
      async list(kind: string) {
        const snap = kind === "person" ? [person("a"), person("b")] : [];
        if (kind === "person") await gate;
        return snap;
      },
      async get() {
        return undefined;
      },
      async onChange(kind: string, fn: (c: ConfigChange) => unknown) {
        handlers.push({ kind, fn });
        return () => {};
      },
    } as unknown as ConfigStore;
    const dir = createDirectory(store, { logger: quiet });
    await tick();
    handlers.find((h) => h.kind === "person")!.fn({ kind: "person", id: "a", op: "delete" });
    await tick();
    release();
    await dir.ready;
    expect(dir.person("a")).toBeUndefined();
    expect(dir.person("b")?.id).toBe("b");
    void ({} as Group);
  });
});

/** Minimal in-memory Redis covering what the engine uses. */
function fakeRedis(opts: { failEnqueue?: () => boolean } = {}) {
  const calls: Array<{ cmd: string; args: unknown[] }> = [];
  const acked: string[] = [];
  const pending = new Map<string, { fields: string[]; deliveries: number }>();
  let fresh: Array<[string, string[]]> = [];
  let groupMissing = false;
  const pushed: string[] = [];
  let quitCalled = false;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const self: Record<string, unknown> = {
    calls,
    acked,
    pending,
    pushed,
    addEntry(id: string, event: Event) {
      fresh.push([id, ["data", JSON.stringify(event)]]);
    },
    dropGroup() {
      groupMissing = true;
    },
    get quitCalled() {
      return quitCalled;
    },
    async xgroup(...args: unknown[]) {
      calls.push({ cmd: "xgroup", args });
      groupMissing = false;
      return "OK";
    },
    duplicate: () => self,
    async quit() {
      quitCalled = true;
    },
    disconnect() {},
    async xadd() {
      return "1-0";
    },
    async publish() {
      return 0;
    },
    async lpush(_k: string, v: string) {
      if (opts.failEnqueue?.()) throw new Error("redis down");
      pushed.push(v);
      return 1;
    },
    async xack(_s: string, _g: string, id: string) {
      acked.push(id);
      pending.delete(id);
      return 1;
    },
    async xreadgroup() {
      if (groupMissing) throw new Error("NOGROUP No such key");
      const batch = fresh;
      fresh = [];
      for (const [id, fields] of batch) pending.set(id, { fields, deliveries: 1 });
      if (batch.length === 0) {
        await sleep(5);
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
    calls: typeof calls;
    acked: string[];
    pending: typeof pending;
    pushed: string[];
    addEntry(id: string, e: Event): void;
    dropGroup(): void;
    quitCalled: boolean;
  };
}

const rulesStore = (rules: Rule[], people: Person[]) =>
  ({
    async list(kind: string) {
      return kind === "rule" ? rules : kind === "person" ? people : [];
    },
    async get() {
      return undefined;
    },
    async onChange() {
      return () => {};
    },
  }) as unknown as ConfigStore;

async function until(fn: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("engine runner (fake redis)", () => {
  const rule = mkRule([{ recipients: [{ type: "person", id: "a" }] }]);
  const store = () => rulesStore([rule], [person("a")]);

  it("creates the group at id 0, acks on success, recreates the group on NOGROUP, quits the reader", async () => {
    const redis = fakeRedis();
    const engine = createEngine({ redis, store: store(), logger: quiet, blockMs: 5 });
    await engine.start();
    expect(redis.calls[0]!.args).toEqual(["CREATE", expect.any(String), expect.any(String), "0", "MKSTREAM"]);
    redis.addEntry("1-0", mkEvent());
    await until(() => redis.acked.includes("1-0"));
    expect(redis.pushed).toHaveLength(1);
    redis.dropGroup();
    await until(() => redis.calls.length >= 2);
    redis.addEntry("2-0", mkEvent());
    await until(() => redis.acked.includes("2-0"));
    await engine.stop();
    expect(redis.quitCalled).toBe(true);
  });

  it("leaves a failed event pending, retries it with the same ids, then gives up after max deliveries", async () => {
    let fail = true;
    const redis = fakeRedis({ failEnqueue: () => fail });
    const engine = createEngine({
      redis,
      store: store(),
      logger: quiet,
      blockMs: 5,
      reclaimEveryMs: 10,
      reclaimMinIdleMs: 0,
      maxDeliveries: 8,
    });
    await engine.start();
    redis.addEntry("1-0", mkEvent());
    await until(() => redis.pending.get("1-0")?.deliveries === 2);
    expect(redis.acked).toEqual([]);
    fail = false;
    await until(() => redis.acked.includes("1-0"));
    expect(redis.pushed).toHaveLength(1);

    fail = true;
    redis.addEntry("3-0", mkEvent());
    await until(() => redis.acked.includes("3-0"));
    expect(redis.pushed).toHaveLength(1);
    await engine.stop();
  });

  it("closes the caches when start fails", async () => {
    const redis = fakeRedis();
    (redis as unknown as Record<string, unknown>).xgroup = async () => {
      throw new Error("boom");
    };
    const unsub = vi.fn();
    const s = { ...rulesStore([], []), onChange: async () => unsub } as unknown as ConfigStore;
    const engine = createEngine({ redis, store: s, logger: quiet });
    await expect(engine.start()).rejects.toThrow("boom");
    expect(unsub).toHaveBeenCalled();
  });
});
