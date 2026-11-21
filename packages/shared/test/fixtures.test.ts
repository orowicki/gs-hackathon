import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALERT_STATES,
  SEVERITY_ORDER,
  compareSeverity,
  type Alert,
  type AlertState,
} from "../src/index.js";

const root = join(import.meta.dirname, "..", "..", "..", "fixtures");
const files = (dir: string) => readdirSync(join(root, dir)).map((f) => join(root, dir, f));

describe("event fixtures", () => {
  it("has json events that parse and the unparseable one that does not", () => {
    const all = files("events");
    expect(all.length).toBeGreaterThanOrEqual(4);
    for (const f of all) {
      const text = readFileSync(f, "utf8");
      if (f.endsWith(".json")) {
        const ev = JSON.parse(text) as Record<string, unknown>;
        const required = f.includes("workflow")
          ? ["type", "workflowId", "workflowName", "step", "severity", "environment", "timestamp", "error"]
          : f.includes("metric")
            ? ["alertname", "labels", "annotations", "startsAt", "status"]
            : ["meta", "payload"];
        for (const k of required) expect(ev, `${f}: ${k}`).toHaveProperty(k);
      } else expect(() => JSON.parse(text), f).toThrow();
    }
  });
});

type Kind = "string" | "number" | "array" | "object";
/** Required keys of Alert and their primitive types (must stay in sync with Alert). */
const ALERT_REQUIRED: Record<keyof Pick<Alert, "id" | "ruleId" | "eventId" | "schemaId" | "dedupKey" | "state" | "severity" | "title" | "source" | "environment" | "count" | "firstSeen" | "lastSeen" | "fields" | "common">, Kind | "stringOrNull"> = {
  id: "string",
  ruleId: "string",
  eventId: "string",
  schemaId: "stringOrNull",
  dedupKey: "string",
  state: "string",
  severity: "string",
  title: "string",
  source: "string",
  environment: "string",
  count: "number",
  firstSeen: "string",
  lastSeen: "string",
  fields: "array",
  common: "object",
};

function kindOk(v: unknown, k: Kind | "stringOrNull"): boolean {
  if (k === "array") return Array.isArray(v);
  if (k === "object") return typeof v === "object" && v !== null && !Array.isArray(v);
  if (k === "stringOrNull") return v === null || typeof v === "string";
  return typeof v === k;
}

/** Returns a list of problems; empty means the value is a valid Alert. */
function alertProblems(v: unknown): string[] {
  const o = (v ?? {}) as Record<string, unknown>;
  const out: string[] = [];
  for (const [key, k] of Object.entries(ALERT_REQUIRED))
    if (!(key in o) || !kindOk(o[key], k)) out.push(`${key}: expected ${k}`);
  if (!(o.severity as string in SEVERITY_ORDER)) out.push("severity: not in SEVERITY_ORDER");
  if (!ALERT_STATES.includes(o.state as AlertState)) out.push("state: not an AlertState");
  if (Date.parse(String(o.firstSeen)) !== Date.parse(String(o.firstSeen))) out.push("firstSeen: bad date");
  if (Date.parse(String(o.lastSeen)) !== Date.parse(String(o.lastSeen))) out.push("lastSeen: bad date");
  if (typeof o.count === "number" && o.count < 1) out.push("count: < 1");
  if (o.state === "acknowledged" && !o.acknowledgedBy) out.push("acknowledgedBy missing");
  if (o.state === "resolved" && !o.resolvedAt) out.push("resolvedAt missing");
  return out;
}

describe("alert fixtures", () => {
  const alerts = files("alerts").map((f) => ({
    f,
    alert: JSON.parse(readFileSync(f, "utf8")) as unknown,
  }));

  it("one alert per json event", () => {
    const events = files("events").filter((f) => f.endsWith(".json")).length;
    expect(alerts).toHaveLength(events);
  });

  // Convention: alert fixture X.json has eventId "evt-X" and links to events/X.json.
  const expected: Record<string, { severity: string; dedupKey: string }> = {
    "workflow-failed": { severity: "error", dedupKey: "order-settlement-validate-counterparty" },
    "metric-breach": { severity: "critical", dedupKey: "HighErrorRate-payments-api" },
    "trade-rejected": { severity: "info", dedupKey: "T-998877" },
  };

  it.each(alerts)("$f links to an event fixture and is consistent with it", ({ f, alert }) => {
    const a = alert as Alert;
    const name = basename(f, ".json");
    expect(a.eventId).toBe(`evt-${name}`);
    const ev = JSON.parse(readFileSync(join(root, "events", `${name}.json`), "utf8")) as { workflowName: string; step: string; severity: string; alertname: string; labels: { service: string; severity: string }; payload: { tradeId: string } };
    const exp = expected[name]!;
    expect(a.severity).toBe(exp.severity);
    expect(a.common.severity).toBe(exp.severity);
    expect(a.dedupKey).toBe(exp.dedupKey);
    // Spot-check against the event payload itself.
    if (name === "workflow-failed") {
      expect(a.dedupKey).toBe(`${ev.workflowName}-${ev.step}`);
      expect(a.severity).toBe(String(ev.severity).toLowerCase());
    }
    if (name === "metric-breach") {
      expect(a.dedupKey).toBe(`${ev.alertname}-${ev.labels.service}`);
      expect(a.severity).toBe(ev.labels.severity);
    }
    if (name === "trade-rejected") expect(a.dedupKey).toBe(ev.payload.tradeId);
  });

  it.each(alerts)("$f is a valid Alert", ({ alert }) => {
    expect(alertProblems(alert)).toEqual([]);
  });

  it("rejects a deliberately broken alert", () => {
    const broken = { ...(alerts[0]!.alert as object), severity: "fatal", state: "closed", count: "3" };
    delete (broken as Record<string, unknown>).ruleId;
    const problems = alertProblems(broken);
    expect(problems).toEqual(
      expect.arrayContaining(["ruleId: expected string", "count: expected number", "severity: not in SEVERITY_ORDER", "state: not an AlertState"]),
    );
  });
});

describe("severity order", () => {
  it("critical > error > warning > info", () => {
    expect(SEVERITY_ORDER.critical).toBeGreaterThan(SEVERITY_ORDER.error);
    expect(compareSeverity("error", "warning")).toBeGreaterThan(0);
    expect(compareSeverity("info", "warning")).toBeLessThan(0);
    expect(compareSeverity("info", "info")).toBe(0);
  });
});
