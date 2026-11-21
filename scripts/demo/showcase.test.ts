import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluate, parse } from "@alerting/filter";
import { classifyEvent, type SchemaDef } from "@alerting/schemas";
import { compileRule, matchRules } from "@alerting/engine";
import type { Event, Rule } from "@alerting/shared";
import { REPO_ROOT, loadConfigDir } from "../seed/seed.ts";
import { alertContext } from "../../packages/api/dist/routes/alerts/filter-context.js";
import { nextEvent, showcase, type DemoEvent } from "./events.ts";

// Runs the scripted showcase through the real schema mapping and rule filters from config/, with a
// simplified dedup (key = rule id + dedupKey; a resolved status closes the open alert).
const data = loadConfigDir(join(REPO_ROOT, "config"));
const schemas = data.schema.map((s) => s.entity) as unknown as SchemaDef[];
const rules = data.rule.map((r) => compileRule(r.entity as unknown as Rule));

interface SimAlert {
  ruleId: string;
  severity: string;
  source: string;
  environment: string;
  title: string;
  dedupKey: string;
  schemaId: string;
  common: Record<string, unknown>;
  count: number;
  state: "open" | "resolved";
}

function simulate(): SimAlert[] {
  const alerts: SimAlert[] = [];
  const current = new Map<string, SimAlert>();
  for (const step of showcase(new Date("2026-11-21T10:00:00Z"))) {
    const raw = JSON.parse(step.event.line);
    const c = classifyEvent(raw, schemas);
    expect(c.schemaId, step.event.line).not.toBeNull();
    const event = { id: "x", sourceId: "s", schemaId: c.schemaId, raw, parsed: c.parsed, common: c.common } as unknown as Event;
    for (const r of matchRules(event, rules)) {
      const key = `${r.rule.id}\u0000${c.common.dedupKey}`;
      const open = current.get(key);
      if (c.common.sourceStatus === "resolved") {
        if (open) {
          open.state = "resolved";
          current.delete(key);
        }
      } else if (open) {
        open.count++;
      } else {
        const a: SimAlert = {
          ruleId: r.rule.id,
          severity: c.common.severity as string,
          source: c.common.source as string,
          environment: c.common.environment as string,
          title: c.common.title as string,
          dedupKey: c.common.dedupKey as string,
          schemaId: c.schemaId as string,
          common: c.common as Record<string, unknown>,
          count: 1,
          state: "open",
        };
        alerts.push(a);
        current.set(key, a);
      }
    }
  }
  return alerts;
}

describe("demo showcase", () => {
  const alerts = simulate();
  const open = alerts.filter((a) => a.state === "open");

  it("has at least 2 OPEN alerts of each severity", () => {
    for (const sev of ["critical", "error", "warning", "info"]) {
      expect(open.filter((a) => a.severity === sev).length, sev).toBeGreaterThanOrEqual(2);
    }
  });

  it("spans at least 4 sources and 2 environments", () => {
    expect(new Set(alerts.map((a) => a.source)).size).toBeGreaterThanOrEqual(4);
    expect([...new Set(alerts.map((a) => a.environment))].sort()).toEqual(["prod", "staging"]);
  });

  it("has repeated and resolved alerts", () => {
    expect(alerts.some((a) => a.count > 1)).toBe(true);
    expect(alerts.some((a) => a.state === "resolved")).toBe(true);
  });

  it("fires every seeded rule at least once", () => {
    const fired = new Set(alerts.map((a) => a.ruleId));
    expect([...fired].sort()).toEqual(data.rule.map((r) => r.id).sort());
  });

  it("relies on the four seeded rules only", () => {
    expect(data.rule.length).toBe(4);
  });

  // The same filter context the alerts API uses; each README filter must give what the README says.
  const run = (f: string) => {
    const tree = parse(f);
    return alerts.filter((a) => evaluate(tree, alertContext(a as never)));
  };
  const names = (xs: SimAlert[]) => xs.map((a) => `${a.source}`).sort();

  it("README filters return what the README claims", () => {
    const crit = run("alert.severity = critical");
    expect(crit.length).toBe(4);
    expect(crit.filter((a) => a.state === "resolved").map((a) => a.environment)).toEqual(["staging"]);
    expect(names(crit)).toEqual(["order-settlement", "payments-api", "payments-api", "pricing-engine-apac"]);

    const pay = run("alert.source = payments-api");
    expect(pay.map((a) => [a.environment, a.state, a.count])).toEqual([
      ["prod", "open", 3],
      ["staging", "resolved", 1],
    ]);

    expect(run("alert.environment = staging").map((a) => [a.source, a.state]).sort()).toEqual([
      ["payments-api", "resolved"],
      ["pricing-engine-staging", "open"],
    ]);

    const live = run("alert.status != resolved");
    expect(live.length).toBe(alerts.length - 2);
    expect(live.every((a) => a.state === "open")).toBe(true);

    expect(names(run("alert.count > 1"))).toEqual(["order-settlement", "payments-api", "pricing-engine-apac"]);
  });

  it("random events never reuse a showcase dedup key", () => {
    const keyOf = (e: DemoEvent) => {
      const raw = JSON.parse(e.line);
      return classifyEvent(raw, schemas).common.dedupKey;
    };
    const used = new Set(showcase(new Date()).map((s) => keyOf(s.event)));
    for (const seed of [1, 2, 3, 4, 5]) {
      let st = seed;
      const rng = () => (st = (st * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32;
      const recent: DemoEvent[] = [];
      for (let i = 0; i < 500; i++) {
        const e = nextEvent(rng, new Date(), recent);
        recent.push(e);
        if (recent.length > 10) recent.shift();
        if (e.kind === "junk") continue;
        const k = keyOf(e);
        expect(k, `${e.line}`).toBeTruthy();
        expect(used.has(k), `${k}`).toBe(false);
      }
    }
  });

  it("keeps all events of one dedup key on the same sink", () => {
    const sinkOf = new Map<string, string>();
    for (const step of showcase(new Date())) {
      const raw = JSON.parse(step.event.line);
      const c = classifyEvent(raw, schemas);
      const key = `${c.common.dedupKey}|${c.common.environment ?? "prod"}`;
      expect(sinkOf.get(key) ?? step.sink, key).toBe(step.sink);
      sinkOf.set(key, step.sink);
    }
  });
});
