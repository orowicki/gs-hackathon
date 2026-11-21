import { describe, expect, it } from "vitest";
import { formatDate, formatPrimitive, formatTimestamp, humanize, objectNodes, parseTimestamp, relativeTime } from "./format";

describe("humanize", () => {
  it("humanises keys", () => {
    expect(humanize("workflowId")).toBe("Workflow ID");
    expect(humanize("startsAt")).toBe("Starts at");
    expect(humanize("error_code")).toBe("Error code");
    expect(humanize("type")).toBe("Type");
    expect(humanize("dedupKey")).toBe("Dedup key");
  });
});

describe("timestamps", () => {
  const local = new Date(2026, 9, 23, 9, 14, 2);
  it("formats date and relative time", () => {
    expect(formatDate(local)).toBe("23 Oct 2026, 09:14:02");
    const now = new Date(local.getTime() + 120_000);
    expect(formatTimestamp(local, now)).toBe("23 Oct 2026, 09:14:02 (2 min ago)");
    expect(relativeTime(local, new Date(local.getTime() - 3 * 3600_000))).toBe("in 3 h");
    expect(relativeTime(local, local)).toBe("just now");
  });
  it("parses ISO strings and epoch only for time-like keys", () => {
    expect(parseTimestamp("x", "2026-10-23T09:14:02.331Z")?.toISOString()).toBe("2026-10-23T09:14:02.331Z");
    expect(parseTimestamp("x", "hello")).toBeNull();
    expect(parseTimestamp("startsAt", 1_792_000_000)?.getTime()).toBe(1_792_000_000_000);
    expect(parseTimestamp("createdAt", 1_792_000_000_000)?.getTime()).toBe(1_792_000_000_000);
    expect(parseTimestamp("amount", 1_792_000_000)).toBeNull();
    expect(parseTimestamp("timestamp", 42)).toBeNull();
  });
});

describe("formatPrimitive", () => {
  it("formats values", () => {
    expect(formatPrimitive("amount", 25000000).text).toBe("25,000,000");
    expect(formatPrimitive("retries", 3).text).toBe("3");
    expect(formatPrimitive("accountId", 1234567).text).toBe("1234567");
    expect(formatPrimitive("ok", true).text).toBe("Yes");
    expect(formatPrimitive("ok", false).text).toBe("No");
    expect(formatPrimitive("x", null)).toMatchObject({ text: "—", muted: true });
    expect(formatPrimitive("x", "")).toMatchObject({ text: "—", muted: true });
    expect(formatPrimitive("workflowId", "WF-1").mono).toBe(true);
    expect(formatPrimitive("message", "Did not respond").mono).toBe(false);
  });
});

describe("objectNodes", () => {
  it("keeps order, nests objects, numbers arrays of objects", () => {
    const nodes = objectNodes({
      zeta: 1,
      alpha: "a",
      error: { code: "TIMEOUT" },
      tags: ["a", "b"],
      alerts: [{ name: "x" }, { name: "y" }],
      none: {},
    });
    expect(nodes.map((n) => n.key)).toEqual(["zeta", "alpha", "error", "tags", "alerts", "none"]);
    const err = nodes[2];
    expect(err.kind === "section" && err.children[0].path).toBe("error.code");
    const tags = nodes[3];
    expect(tags.kind === "field" && tags.display.text).toBe("a, b");
    const alerts = nodes[4];
    expect(alerts.kind === "section" && alerts.children.map((c) => c.label)).toEqual(["Alert 1", "Alert 2"]);
    expect(nodes[5].kind === "field" && nodes[5].display.muted).toBe(true);
  });
});
