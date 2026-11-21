import { describe, expect, it } from "vitest";
import { evaluate } from "@alerting/filter";
import { parseRange, rangeTree, withRange, withRangeTree } from "./timeRange";

describe("time range", () => {
  it("reads and writes the range param", () => {
    expect(parseRange("24h")).toBe("24h");
    expect(parseRange("bogus")).toBe("all");
    expect(parseRange(null)).toBe("all");
    expect(withRange(new URLSearchParams("q=a"), "7d").toString()).toBe("q=a&range=7d");
    expect(withRange(new URLSearchParams("q=a&range=7d"), "all").toString()).toBe("q=a");
  });

  it("keeps only alerts seen within the range, combined with the filter", () => {
    const now = Date.parse("2026-11-21T12:00:00Z");
    const recent = { alert: { severity: "critical", lastSeen: "2026-11-21T09:00:00Z" }, now };
    const old = { alert: { severity: "critical", lastSeen: "2026-11-19T09:00:00Z" }, now };
    const tree = withRangeTree({ type: "cmp", field: "alert.severity", op: "=", value: "critical" }, "24h");
    expect(evaluate(tree, recent)).toBe(true);
    expect(evaluate(tree, old)).toBe(false);
    expect(rangeTree("all")).toBeNull();
    expect(withRangeTree(null, "all")).toBeNull();
  });
});
