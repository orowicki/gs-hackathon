import { describe, expect, it } from "vitest";
import { evaluate, parse } from "@alerting/filter";
import { rangeOf, setRange, withoutRange } from "./timeRange";

describe("time range in the filter text", () => {
  it("adds the condition in filter syntax, replacing an earlier range", () => {
    expect(setRange("", "24h")).toBe("alert.occurredAt >= now-24h");
    expect(setRange("alert.severity = critical", "24h")).toBe("alert.severity = critical AND alert.occurredAt >= now-24h");
    expect(setRange("alert.severity = critical AND alert.occurredAt >= now-24h", "7d")).toBe(
      "alert.severity = critical AND alert.occurredAt >= now-7d",
    );
    expect(setRange("alert.severity = critical AND alert.occurredAt >= now-24h", "all")).toBe("alert.severity = critical");
    expect(setRange("a = 1 OR b = 2", "1h")).toBe("(a = 1 OR b = 2) AND alert.occurredAt >= now-1h");
  });

  it("reads the range back from the text", () => {
    expect(rangeOf("alert.occurredAt >= now-24h")).toBe("24h");
    expect(rangeOf("x = 1 and alert.occurredAt >= NOW-7d")).toBe("7d");
    expect(rangeOf("alert.occurredAt >= now-3d")).toBe("all"); // not one of the picker's ranges
    expect(rangeOf("alert.severity = critical")).toBe("all");
    expect(rangeOf("(unclosed")).toBe("all");
  });

  it("withoutRange strips only the picker's condition", () => {
    expect(withoutRange("alert.severity = critical AND alert.occurredAt >= now-24h")).toBe("alert.severity = critical");
    expect(withoutRange("alert.severity = critical")).toBe("alert.severity = critical");
  });

  it("never loses text that does not parse yet", () => {
    expect(setRange("alert.severity =", "24h")).toBe("alert.severity = AND alert.occurredAt >= now-24h");
    expect(setRange("alert.severity =", "all")).toBe("alert.severity =");
  });

  it("the written condition filters by time", () => {
    const now = Date.parse("2026-11-21T12:00:00Z");
    const tree = parse(setRange("alert.severity = critical", "24h"));
    expect(evaluate(tree, { alert: { severity: "critical", occurredAt: "2026-11-21T09:00:00Z" }, now })).toBe(true);
    expect(evaluate(tree, { alert: { severity: "critical", occurredAt: "2026-11-19T09:00:00Z" }, now })).toBe(false);
  });
});
