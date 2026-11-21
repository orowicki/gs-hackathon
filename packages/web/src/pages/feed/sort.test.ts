import type { Alert } from "@alerting/shared";
import { describe, expect, it } from "vitest";
import { parseSort, sortBy } from "./helpers";

const a = (id: string, severity: Alert["severity"], count: number, firstSeen: string, lastSeen: string) =>
  ({ id, severity, count, firstSeen, lastSeen }) as Alert;
const list = [
  a("old-crit", "critical", 1, "2026-11-21T01:00:00Z", "2026-11-21T01:00:00Z"),
  a("new-info", "info", 9, "2026-11-21T05:00:00Z", "2026-11-21T06:00:00Z"),
  a("mid-warn", "warning", 3, "2026-11-21T03:00:00Z", "2026-11-21T07:00:00Z"),
];

describe("feed sort", () => {
  it("orders by the API's sort keys, descending", () => {
    expect(sortBy(list, "lastSeen").map((x) => x.id)).toEqual(["mid-warn", "new-info", "old-crit"]);
    expect(sortBy(list, "severity").map((x) => x.id)).toEqual(["old-crit", "mid-warn", "new-info"]);
    expect(sortBy(list, "count").map((x) => x.id)).toEqual(["new-info", "mid-warn", "old-crit"]);
    expect(sortBy(list, "firstSeen").map((x) => x.id)).toEqual(["new-info", "mid-warn", "old-crit"]);
  });
  it("falls back to latest activity for unknown values", () => {
    expect(parseSort("nonsense")).toBe("lastSeen");
    expect(parseSort("count")).toBe("count");
  });
});
