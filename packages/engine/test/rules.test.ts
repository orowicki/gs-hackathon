import { describe, expect, it, vi } from "vitest";
import type { ConfigStore } from "@alerting/config";
import type { ConfigChange, Event, Rule } from "@alerting/shared";
import {
  createRuleCache,
  createStaticRuleCache,
  matchRules,
  renderLooks,
  renderTemplate,
} from "../src/index.js";

const rule = (id: string, when: Rule["when"], extra: Partial<Rule> = {}): Rule => ({
  id,
  name: `Rule ${id}`,
  enabled: true,
  when,
  who: [],
  looks: { titleTemplate: "{{title}}", fields: [] },
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  ...extra,
});

const event = (over: Record<string, unknown> = {}, parsed: Event["parsed"] = {}): Event =>
  ({
    id: "e1",
    sourceId: "s1",
    receivedAt: "2026-01-01T00:00:00Z",
    raw: "",
    parsed: { payload: { notional: 20000000, currency: "EUR" }, ...parsed },
    schemaId: "sch",
    common: { severity: "error", title: "Boom", source: "pricing-engine-1", ...over },
  }) as unknown as Event;

const ids = (rules: Rule[], ev: Event) =>
  matchRules(ev, createStaticRuleCache(rules, { error() {} }).rules()).map((c) => c.rule.id);

describe("matchRules", () => {
  it("fires every matching rule, skips non-matching and disabled", () => {
    const rules = [
      rule("a", "alert.severity >= warning"),
      rule("b", "payload.notional > 10000000"),
      rule("c", "alert.severity = info"),
      rule("d", null as never),
      rule("e", "", { enabled: false }),
    ];
    expect(ids(rules, event())).toEqual(["a", "b", "d"]);
  });

  it("accepts text and tree when", () => {
    const tree = { type: "cmp", field: "alert.source", op: "matches", value: "pricing-*" } as const;
    expect(ids([rule("t", tree), rule("x", "alert.source matches pricing-*")], event())).toEqual(["t", "x"]);
    expect(ids([rule("n", "alert.source matches other-*")], event())).toEqual([]);
  });

  it("orders severity and defaults to info", () => {
    expect(ids([rule("a", "alert.severity >= error")], event({ severity: "warning" }))).toEqual([]);
    expect(ids([rule("a", "alert.severity = info")], event({ severity: undefined }))).toEqual(["a"]);
  });

  it("has no alert.status in when", () => {
    expect(ids([rule("a", "alert.status = open")], event({ status: "open" }))).toEqual([]);
  });

  it("skips an invalid rule without throwing", () => {
    const err = vi.fn();
    const cache = createStaticRuleCache([rule("bad", "alert.severity >>> x"), rule("ok", "")], { error: err });
    expect(cache.rules().map((c) => c.rule.id)).toEqual(["ok"]);
    expect(err).toHaveBeenCalledOnce();
  });
});

function fakeStore() {
  const rules = new Map<string, Rule>();
  const handlers = new Set<(c: ConfigChange) => unknown>();
  const emit = (c: ConfigChange) => handlers.forEach((h) => h(c));
  const store = {
    list: async () => [...rules.values()],
    get: async (_k: string, id: string) => rules.get(id),
    onChange: async (_k: string, h: (c: ConfigChange) => unknown) => {
      handlers.add(h);
      return () => handlers.delete(h);
    },
  } as unknown as ConfigStore;
  return {
    store,
    upsert(r: Rule) {
      rules.set(r.id, r);
      emit({ kind: "rule", id: r.id, op: "upsert" });
    },
    remove(id: string) {
      rules.delete(id);
      emit({ kind: "rule", id, op: "delete" });
    },
    seed: (r: Rule) => rules.set(r.id, r),
    handlers,
  };
}

async function waitFor(fn: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("rule cache live reload", () => {
  it("loads, upserts, disables and deletes", async () => {
    const f = fakeStore();
    f.seed(rule("a", ""));
    const cache = createRuleCache(f.store, { logger: { error() {} } });
    await cache.ready;
    expect(cache.rules().map((c) => c.rule.id)).toEqual(["a"]);

    f.upsert(rule("b", "alert.severity = error"));
    await waitFor(() => cache.rules().length === 2);

    f.upsert(rule("b", "", { enabled: false, updatedAt: "2026-02-01T00:00:00Z" }));
    await waitFor(() => cache.rules().length === 1);

    f.upsert(rule("a", "payload.x = (", { updatedAt: "2026-02-01T00:00:00Z" }));
    await waitFor(() => cache.rules().length === 0);

    f.upsert(rule("c", ""));
    await waitFor(() => cache.rules().length === 1);
    f.remove("c");
    await waitFor(() => cache.rules().length === 0);

    cache.close();
    expect(f.handlers.size).toBe(0);
  });
});

describe("looks", () => {
  it("renders paths, common fields, missing values and objects", () => {
    const ev = event({}, { payload: { notional: 5, currency: "EUR", nested: { a: 1 } } });
    expect(renderTemplate("{{payload.currency}} {{ payload.notional }} {{alert.severity}} {{title}}", ev)).toBe(
      "EUR 5 error Boom",
    );
    expect(renderTemplate("[{{payload.nope}}]", ev)).toBe("[]");
    expect(renderTemplate("{{payload.nested}}", ev)).toBe('{"a":1}');
  });

  it("renderLooks: fields, severity override, fallbacks", () => {
    const r = rule("a", "", {
      looks: {
        titleTemplate: "{{payload.currency}} alert",
        bodyTemplate: "n={{payload.notional}}",
        fields: ["payload.currency", "payload.missing"],
        severityOverride: "critical",
        colour: "#f00",
      },
    });
    expect(renderLooks(r, event())).toEqual({
      title: "EUR alert",
      body: "n=20000000",
      fields: [
        { path: "payload.currency", value: "EUR" },
        { path: "payload.missing", value: "" },
      ],
      severity: "critical",
      colour: "#f00",
    });
    const r2 = rule("b", "", { looks: { titleTemplate: "{{payload.none}}", fields: [] } });
    const out = renderLooks(r2, event({ title: undefined, severity: undefined }));
    expect(out.title).toBe("Rule b");
    expect(out.severity).toBe("info");
    expect(renderLooks(r2, event()).title).toBe("Boom");
  });
});
