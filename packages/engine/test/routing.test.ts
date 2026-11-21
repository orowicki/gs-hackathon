import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { entityId, fromYaml, type ConfigStore } from "@alerting/config";
import type { ConfigChange, Event, Group, Notification, Person, Preference, Rule } from "@alerting/shared";
import {
  compileRule,
  createDirectory,
  createStaticDirectory,
  createStaticRuleCache,
  inQuietHours,
  matchRules,
  processEvent,
  routeAlert,
  buildAlert,
  type CompiledRule,
} from "../src/index.js";

const silent = { error() {} };
const root = join(import.meta.dirname, "..", "..", "..");

const person = (id: string, extra: Partial<Person> = {}): Person => ({
  id,
  name: id,
  role: "dev",
  canCreateRules: false,
  ...extra,
});
const group = (id: string, memberIds: string[]): Group => ({ id, name: id, memberIds });

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

const mkEvent = (severity: string, extra: Record<string, unknown> = {}): Event =>
  ({
    id: "e1",
    sourceId: "s1",
    receivedAt: "2026-01-01T00:00:00Z",
    raw: "",
    parsed: {},
    schemaId: null,
    common: { severity, title: "Boom", source: "svc", environment: "prod", ...extra },
  }) as unknown as Event;

const NOON = new Date("2026-06-01T12:00:00Z");

function route(rule: Rule, event: Event, dir: ReturnType<typeof createStaticDirectory>, now = NOON) {
  const compiled = compileRule(rule);
  const alert = buildAlert(event, compiled, now);
  return routeAlert({ alert, event, rule: compiled, directory: dir, now, logger: silent, publicUrl: "https://x" });
}
const pairs = (ns: Notification[]) => ns.map((n) => `${n.recipientId}:${n.channel}`).sort();

describe("routeAlert", () => {
  const people = [person("a", { ntfyTopic: "ta" }), person("b"), person("c", { ntfyTopic: "tc" })];

  it("notifies a person in two matched groups once", () => {
    const dir = createStaticDirectory({ people, groups: [group("g1", ["a", "b"]), group("g2", ["b", "c"])] });
    const rule = mkRule([
      {
        recipients: [
          { type: "group", id: "g1" },
          { type: "group", id: "g2" },
        ],
      },
    ]);
    const ns = route(rule, mkEvent("info"), dir);
    expect(pairs(ns)).toEqual(["a:ui", "b:ui", "c:ui"]);
  });

  it("follows preferences by severity, default otherwise", () => {
    const pref: Preference = {
      ownerType: "person",
      ownerId: "a",
      rules: [
        { when: "alert.severity = critical", channels: ["ntfy", "ui"] },
        { when: "alert.severity = info", channels: ["ui"] },
      ],
    };
    const dir = createStaticDirectory({ people, preferences: [pref] });
    const rule = mkRule([{ recipients: [{ type: "person", id: "a" }] }]);
    expect(pairs(route(rule, mkEvent("critical"), dir))).toEqual(["a:ntfy", "a:ui"]);
    expect(pairs(route(rule, mkEvent("info"), dir))).toEqual(["a:ui"]);
    // no preference rule matches -> default (error + ntfyTopic -> ntfy too)
    expect(pairs(route(rule, mkEvent("error"), dir))).toEqual(["a:ntfy", "a:ui"]);
    expect(pairs(route(rule, mkEvent("warning"), dir))).toEqual(["a:ui"]);
  });

  it("default adds ntfy for error/critical only with an ntfyTopic", () => {
    const dir = createStaticDirectory({ people });
    const rule = mkRule([{ recipients: [{ type: "person", id: "b" }] }]);
    expect(pairs(route(rule, mkEvent("critical"), dir))).toEqual(["b:ui"]);
  });

  it("uses the group preference when the person has none; person preference wins", () => {
    const gp: Preference = {
      ownerType: "group",
      ownerId: "g1",
      rules: [{ when: "alert.severity >= info", channels: ["ntfy"] }],
    };
    const pp: Preference = {
      ownerType: "person",
      ownerId: "b",
      rules: [{ when: "alert.severity >= info", channels: ["ui"] }],
    };
    const dir = createStaticDirectory({ people, groups: [group("g1", ["a", "b"])], preferences: [gp, pp] });
    const rule = mkRule([{ recipients: [{ type: "group", id: "g1" }] }]);
    expect(pairs(route(rule, mkEvent("info"), dir))).toEqual(["a:ntfy", "b:ui"]);
  });

  it("quiet hours drop ntfy but keep ui, wrapping midnight, in a non-UTC timezone", () => {
    const pref: Preference = {
      ownerType: "person",
      ownerId: "a",
      rules: [{ when: "alert.severity = critical", channels: ["ntfy", "ui"] }],
      quietHours: { from: "20:00", to: "08:00", timezone: "Asia/Tokyo" },
    };
    const dir = createStaticDirectory({ people, preferences: [pref] });
    const rule = mkRule([{ recipients: [{ type: "person", id: "a" }] }]);
    // 12:00Z = 21:00 in Tokyo -> quiet
    expect(pairs(route(rule, mkEvent("critical"), dir, NOON))).toEqual(["a:ui"]);
    // 02:00Z = 11:00 in Tokyo -> not quiet
    expect(pairs(route(rule, mkEvent("critical"), dir, new Date("2026-06-01T02:00:00Z")))).toEqual(["a:ntfy", "a:ui"]);
    // 20:00Z = 05:00 Tokyo next day -> quiet (after midnight part of the window)
    expect(pairs(route(rule, mkEvent("critical"), dir, new Date("2026-06-01T20:00:00Z")))).toEqual(["a:ui"]);
  });

  it("inQuietHours is [from, to) and honours allowChannels default", () => {
    const q = { from: "09:00", to: "17:00", timezone: "UTC" };
    expect(inQuietHours(q, new Date("2026-06-01T09:00:00Z"))).toBe(true);
    expect(inQuietHours(q, new Date("2026-06-01T17:00:00Z"))).toBe(false);
    expect(inQuietHours({ ...q, timezone: "America/New_York" }, new Date("2026-06-01T13:30:00Z"))).toBe(true);
  });

  it("allowChannels can keep more channels in quiet hours", () => {
    const pref: Preference = {
      ownerType: "person",
      ownerId: "a",
      rules: [{ when: "alert.severity = critical", channels: ["ntfy", "ui"] }],
      quietHours: { from: "00:00", to: "23:59", timezone: "UTC", allowChannels: ["ntfy"] },
    };
    const dir = createStaticDirectory({ people, preferences: [pref] });
    const rule = mkRule([{ recipients: [{ type: "person", id: "a" }] }]);
    expect(pairs(route(rule, mkEvent("critical"), dir))).toEqual(["a:ntfy"]);
  });

  it("force overrides preferences and quiet hours", () => {
    const pref: Preference = {
      ownerType: "person",
      ownerId: "a",
      rules: [{ when: "alert.severity >= info", channels: ["ui"] }],
      quietHours: { from: "00:00", to: "23:59", timezone: "UTC" },
    };
    const dir = createStaticDirectory({ people, preferences: [pref] });
    const rule = mkRule([{ recipients: [{ type: "person", id: "a" }], force: ["ntfy", "ui"] }]);
    expect(pairs(route(rule, mkEvent("info"), dir))).toEqual(["a:ntfy", "a:ui"]);
  });

  it("row order decides, and an unconditioned row is 'everyone else'", () => {
    const dir = createStaticDirectory({ people });
    const rule = mkRule([
      { condition: "alert.severity = critical", recipients: [{ type: "person", id: "a" }], force: ["ntfy"] },
      { condition: "alert.environment = prod", recipients: [{ type: "person", id: "a" }, { type: "person", id: "b" }] },
      { recipients: [{ type: "person", id: "c" }] },
    ]);
    // critical: row1 gives a ntfy; row2 also applies, reaches only b; row3 skipped
    expect(pairs(route(rule, mkEvent("critical"), dir))).toEqual(["a:ntfy", "b:ui"]);
    // not prod, not critical: only the fallback row
    expect(pairs(route(rule, mkEvent("info", { environment: "dev" }), dir))).toEqual(["c:ui"]);
  });

  it("skips unknown recipients and fills notification fields", () => {
    const dir = createStaticDirectory({ people, groups: [group("g", ["a", "ghost"])] });
    const rule = mkRule([
      {
        recipients: [
          { type: "person", id: "nobody" },
          { type: "group", id: "nogroup" },
          { type: "group", id: "g" },
        ],
      },
    ]);
    const ns = route(rule, mkEvent("info", { runbookUrl: "https://rb" }), dir);
    expect(pairs(ns)).toEqual(["a:ui"]);
    const n = ns[0]!;
    expect(n).toMatchObject({
      title: "Hi Boom",
      severity: "info",
      attempt: 0,
      runbookUrl: "https://rb",
      createdAt: NOON.toISOString(),
    });
    expect(n.clickUrl).toBe(`https://x/alerts/${n.alertId}`);
    expect(n.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("processEvent", () => {
  it("builds alerts, routes, enqueues one per recipient+channel and publishes", async () => {
    const dir = createStaticDirectory({
      people: [person("a", { ntfyTopic: "t" }), person("b")],
      groups: [group("g", ["a", "b"])],
    });
    const good = mkRule([{ recipients: [{ type: "group", id: "g" }], force: ["ntfy", "ui"] }], {
      when: "alert.severity >= error",
      looks: { titleTemplate: "Failed: {{title}}", fields: ["source"], colour: "red" },
    });
    const bad = { ...mkRule([]), id: "bad", when: "((" } as Rule;
    const rules = createStaticRuleCache([good, bad], silent).rules();
    const sent: Notification[] = [];
    const published: string[] = [];
    const res = await processEvent(mkEvent("error"), {
      rules,
      directory: dir,
      enqueue: (n) => void sent.push(n),
      publishAlert: (ae) => void published.push(ae.kind),
      logger: silent,
      now: () => NOON,
    });
    expect(pairs(sent)).toEqual(["a:ntfy", "a:ui", "b:ntfy", "b:ui"]);
    expect(sent.every((n) => n.title === "Failed: Boom")).toBe(true);
    expect(res.alerts).toHaveLength(1);
    expect(res.alerts[0]).toMatchObject({ ruleId: "r1", count: 1, colour: "red", fields: [{ label: "source", value: "svc" }] });
    expect(published).toEqual(["created"]);
  });

  it("hook can suppress notifications; one failing rule does not stop the others", async () => {
    const dir = createStaticDirectory({ people: [person("a")] });
    const r1 = mkRule([{ recipients: [{ type: "person", id: "a" }] }], { id: "r1" });
    const r2 = mkRule([{ recipients: [{ type: "person", id: "a" }] }], { id: "r2" });
    const rules = createStaticRuleCache([r1, r2], silent).rules();
    const sent: Notification[] = [];
    let calls = 0;
    await processEvent(mkEvent("info"), {
      rules,
      directory: dir,
      enqueue: (n) => void sent.push(n),
      hooks: {
        onAlert(alert) {
          calls++;
          if (alert.ruleId === "r1") throw new Error("boom");
          return { alert, notify: false };
        },
      },
      logger: silent,
    });
    expect(calls).toBe(2);
    expect(sent).toEqual([]);
    const res = await processEvent(mkEvent("info"), { rules, directory: dir, enqueue: (n) => void sent.push(n), logger: silent });
    expect(res.alerts).toHaveLength(2);
    expect(sent).toHaveLength(2);
  });
});

function fakeStore() {
  const data = { person: new Map<string, unknown>(), group: new Map<string, unknown>(), preference: new Map<string, unknown>() };
  const handlers: Array<{ kind: string; fn: (c: ConfigChange) => unknown }> = [];
  const store = {
    async list(kind: keyof typeof data) {
      return [...data[kind].values()];
    },
    async get(kind: keyof typeof data, id: string) {
      return data[kind].get(id);
    },
    async onChange(kind: string, fn: (c: ConfigChange) => unknown) {
      const h = { kind, fn };
      handlers.push(h);
      return () => void handlers.splice(handlers.indexOf(h), 1);
    },
  };
  const change = async (kind: keyof typeof data, id: string, entity: unknown | undefined) => {
    if (entity === undefined) data[kind].delete(id);
    else data[kind].set(id, entity);
    for (const h of [...handlers]) if (h.kind === kind) await h.fn({ kind, id, op: entity === undefined ? "delete" : "upsert" });
  };
  return { store: store as unknown as ConfigStore, change, data };
}

describe("createDirectory (live)", () => {
  it("loads initial data and follows people, group and preference changes", async () => {
    const f = fakeStore();
    f.data.person.set("a", person("a"));
    const dir = createDirectory(f.store, { logger: silent });
    await dir.ready;
    expect(dir.person("a")?.id).toBe("a");
    expect(dir.person("b")).toBeUndefined();

    await f.change("person", "b", person("b"));
    await f.change("group", "g", group("g", ["a"]));
    expect(dir.person("b")?.id).toBe("b");
    expect(dir.group("g")?.memberIds).toEqual(["a"]);

    await f.change("group", "g", group("g", ["a", "b"]));
    expect(dir.group("g")?.memberIds).toEqual(["a", "b"]);
    await f.change("person", "b", undefined);
    expect(dir.person("b")).toBeUndefined();

    await f.change("preference", "person:a", { ownerType: "person", ownerId: "a", rules: [] });
    expect(dir.preference("person", "a")?.ownerId).toBe("a");
    dir.close();
    await f.change("person", "z", person("z"));
    expect(dir.person("z")).toBeUndefined();
  });
});

describe("seeded config", () => {
  const load = <T>(kind: string): T[] => {
    const d = join(root, "config", kind);
    return readdirSync(d)
      .filter((n) => /\.ya?ml$/.test(n))
      .map((n) => {
        const v = fromYaml(readFileSync(join(d, n), "utf8"));
        entityId(({ people: "person", groups: "group", rules: "rule" } as const)[kind as "people"], v);
        return v as T;
      });
  };
  const people = load<Person>("people");
  const groups = load<Group>("groups");
  const rules = load<Rule>("rules");

  it("has valid rules whose filters parse and recipients resolve", () => {
    expect(rules.map((r) => r.id).sort()).toEqual([
      "anna-payments-critical",
      "pricing-engine-warnings",
      "rates-trade-rejected",
      "settlements-workflow-failed",
    ]);
    const pids = new Set(people.map((p) => p.id));
    const gids = new Set(groups.map((g) => g.id));
    for (const g of groups) for (const m of g.memberIds) expect(pids.has(m), `${g.id} member ${m}`).toBe(true);
    for (const p of people) expect(typeof p.canCreateRules).toBe("boolean");
    for (const r of rules) {
      expect(() => compileRule(r), r.id).not.toThrow();
      for (const w of r.who)
        for (const ref of w.recipients) expect((ref.type === "person" ? pids : gids).has(ref.id), `${r.id} -> ${ref.id}`).toBe(true);
    }
  });

  const ev = (file: string, schemaId: string | null, common: Record<string, unknown>): Event =>
    ({
      id: file,
      sourceId: "s",
      receivedAt: "2026-10-23T09:14:02Z",
      raw: "",
      parsed: JSON.parse(readFileSync(join(root, "fixtures", "events", file), "utf8")),
      schemaId,
      common: { title: file, ...common },
    }) as unknown as Event;
  const matched = (e: Event): string[] => matchRules(e, createStaticRuleCache(rules, silent).rules()).map((c: CompiledRule) => c.rule.id);

  it("fixture events match the intended rules", () => {
    expect(matched(ev("workflow-failed.json", "wf", { severity: "error", source: "workflow-engine", environment: "prod" }))).toEqual([
      "settlements-workflow-failed",
    ]);
    expect(matched(ev("trade-rejected.json", "trade.rejected.v2", { severity: "error", source: "trade-gateway", environment: "prod" }))).toEqual([
      "rates-trade-rejected",
    ]);
    expect(matched(ev("metric-breach.json", "alertmanager", { severity: "critical", source: "payments-api" }))).toEqual([
      "anna-payments-critical",
    ]);
    const pricing = ev("workflow-failed.json", "log", { severity: "warning", source: "pricing-engine-3" });
    pricing.parsed = { line: "WARN slow quote" };
    expect(matched(pricing)).toEqual(["pricing-engine-warnings"]);
    pricing.common = { ...pricing.common, severity: "info" };
    expect(matched(pricing)).toEqual([]);
    const small = ev("trade-rejected.json", "trade.rejected.v2", { severity: "error" });
    (small.parsed.payload as Record<string, unknown>).notional = 5000;
    expect(matched(small)).toEqual([]);
  });

  it("routes the seeded rules end to end", async () => {
    const dir = createStaticDirectory({ people, groups });
    const sent: Notification[] = [];
    const e = ev("trade-rejected.json", "trade.rejected.v2", { severity: "error", source: "trade-gateway" });
    await processEvent(e, { rules: createStaticRuleCache(rules, silent).rules(), directory: dir, enqueue: (n) => void sent.push(n), logger: silent });
    expect(pairs(sent)).toEqual(["anna:ntfy", "anna:ui", "tomasz:ntfy", "tomasz:ui"]);
    expect(sent[0]!.title).toBe("Rejected EUR 25000000 — LIMIT_BREACH");
  });
});
