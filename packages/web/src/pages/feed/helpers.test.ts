import { tryParse } from "@alerting/filter";
import type { Alert } from "@alerting/shared";
import { describe, expect, it } from "vitest";
import { alertContext, fieldNames, filterAlerts, labelKey, parseFilter, relativeTime, severityLabel, sortAlerts, upsertAlert, valuesFor } from "./helpers";
import { seedAlerts } from "./mockSource";

const NOW = Date.parse("2026-11-21T12:00:00Z");
const alerts = seedAlerts(NOW);
const tree = (t: string) => {
  const r = tryParse(t);
  if (!r.ok) throw new Error(r.error.message);
  return r.tree;
};

describe("helpers", () => {
  it("labelKey camel-cases labels", () => {
    expect(labelKey("First name")).toBe("firstName");
    expect(labelKey("Step")).toBe("step");
    expect(labelKey("---")).toBe("");
  });

  it("alertContext exposes the source status as sourceStatus", () => {
    const a = seedAlerts()[0]!;
    const legacy = { ...a, common: { ...a.common, status: "firing" as const } };
    expect(alertContext(legacy).alert.sourceStatus).toBe("firing");
    const renamed = { ...a, common: { ...a.common, sourceStatus: "resolved" } } as unknown as typeof a;
    expect(alertContext(renamed).alert.sourceStatus).toBe("resolved");
    expect(alertContext(renamed).alert.status).toBe(a.state);
  });
  it("alertContext maps lifecycle state to alert.status", () => {
    const a = alerts.find((x) => x.state === "resolved")!;
    expect(alertContext(a).alert.status).toBe("resolved");
    expect(alertContext(a).alert.severity).toBe(a.severity);
    expect(alertContext(a).alert.schema).toBe(a.schemaId);
  });

  it("filters by alert.status, severity and list membership", () => {
    const open = filterAlerts(alerts, tree("alert.status = open"));
    expect(open.length).toBeGreaterThan(0);
    expect(open.every((a) => a.state === "open")).toBe(true);
    const crit = filterAlerts(alerts, tree("alert.severity = critical"));
    expect(crit.every((a) => a.severity === "critical")).toBe(true);
    expect(filterAlerts(alerts, tree("alert.source matches \"pricing-engine-*\"")).length).toBe(1);
    expect(filterAlerts(alerts, null)).toHaveLength(alerts.length);
    expect(filterAlerts(alerts, tree("alert.status = nonsense"))).toHaveLength(0);
  });

  it("parseFilter reports errors and accepts empty text", () => {
    expect(parseFilter("")).toEqual({ ok: true, tree: null });
    const bad = parseFilter("alert.severity =");
    expect(bad.ok).toBe(false);
  });

  it("sorts newest first and upserts by id", () => {
    const sorted = sortAlerts([...alerts].reverse());
    for (let i = 1; i < sorted.length; i++) {
      expect(Date.parse(sorted[i - 1]!.lastSeen)).toBeGreaterThanOrEqual(Date.parse(sorted[i]!.lastSeen));
    }
    const oldest = sorted[sorted.length - 1]!;
    const bumped: Alert = { ...oldest, count: oldest.count + 1, lastSeen: new Date(NOW + 1000).toISOString() };
    const next = upsertAlert(sorted, bumped);
    expect(next).toHaveLength(sorted.length);
    expect(next[0]!.id).toBe(oldest.id);
    expect(sorted[sorted.length - 1]!.id).toBe(oldest.id);
  });

  it("formats severity and relative time", () => {
    expect(severityLabel("critical")).toBe("CRIT");
    expect(severityLabel("error")).toBe("ERR");
    expect(severityLabel("warning")).toBe("WARN");
    expect(severityLabel("info")).toBe("INFO");
    const ago = (s: number) => new Date(NOW - s * 1000).toISOString();
    expect(relativeTime(ago(2), NOW)).toBe("now");
    expect(relativeTime(ago(45), NOW)).toBe("45s");
    expect(relativeTime(ago(120), NOW)).toBe("2m");
    expect(relativeTime(ago(3 * 3600), NOW)).toBe("3h");
    expect(relativeTime(ago(2 * 86400), NOW)).toBe("2d");
  });

  it("collects field names and values for the filter bar", () => {
    const names = fieldNames(alerts, ["event.custom"]);
    expect(names).toContain("alert.severity");
    expect(names).toContain("event.custom");
    expect(names).toEqual([...names].sort());
    const sev = valuesFor(alerts, "alert.severity");
    expect(new Set(sev).size).toBe(sev.length);
    expect(sev[0]).toBe(sortAlerts(alerts)[0]!.severity);
    expect(valuesFor(alerts, "payload.x")).toEqual([]);
  });
});
