import { describe, expect, it } from "vitest";
import { PG_STATEMENTS, REDIS_PATTERNS, purgeRedisPattern } from "./cleanup.mjs";
import { renderChart } from "./chart.mjs";
import { buildBatch, groupBacklog, parseArgs, parseGroups } from "./run.mjs";
import { aggregateRuns, evaluateTargets, median, histogram, percentile, perSecondSeries, summarize } from "./stats.mjs";

describe("stats", () => {
  it("percentile uses nearest rank", () => {
    const v = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(v, 50)).toBe(50);
    expect(percentile(v, 99)).toBe(99);
    expect(percentile(v, 100)).toBe(100);
    expect(percentile([], 50)).toBeNull();
    expect(percentile([7], 99)).toBe(7);
  });
  it("summarize", () => {
    expect(summarize([3, 1, 2])).toEqual({ p50: 2, p90: 3, p99: 3, max: 3, mean: 2, count: 3 });
    expect(summarize([]).count).toBe(0);
  });
  it("histogram buckets", () => {
    expect(histogram([1, 5, 10, 11, 500], [5, 10])).toEqual([
      { le: 5, count: 2 },
      { le: 10, count: 1 },
      { le: Infinity, count: 2 },
    ]);
  });
  it("perSecondSeries fills gaps", () => {
    const s = perSecondSeries([1000, 1500, 3200], [1900, 4100], 1000);
    expect(s).toEqual([
      { t: 0, sent: 2, processed: 1 },
      { t: 1, sent: 0, processed: 0 },
      { t: 2, sent: 1, processed: 0 },
      { t: 3, sent: 0, processed: 1 },
    ]);
  });
  it("targets", () => {
    expect(evaluateTargets(summarize([10, 20]), 0).met).toBe(true);
    expect(evaluateTargets(summarize([10, 300]), 0).met).toBe(false);
    expect(evaluateTargets(summarize([10]), 1).met).toBe(false);
    expect(evaluateTargets(summarize([]), 0).met).toBe(false);
  });
});

describe("large inputs", () => {
  it("stats handle 400k samples without spreading", () => {
    const v = Array.from({ length: 400_000 }, (_, i) => i);
    expect(summarize(v)).toMatchObject({ count: 400_000, max: 399_999 });
    expect(percentile(v, 99)).toBe(395_999);
    expect(histogram(v, [10]).reduce((n, b) => n + b.count, 0)).toBe(400_000);
    const series = perSecondSeries(v.map((i) => i * 0.25), v, 0);
    expect(series.length).toBe(400);
  });
});

describe("run helpers", () => {
  it("parseArgs defaults and smoke", () => {
    const o = parseArgs([], {}, new Date("2026-11-21T10:00:00Z"));
    expect(o).toMatchObject({ rate: 5000, duration: 60, out: "results/loadtest-2026-11-21.json", baseUrl: "http://localhost:3000" });
    expect(parseArgs(["--smoke"], {}).rate).toBe(200);
    expect(parseArgs(["--workers", "4"], {}, new Date("2026-11-21T10:00:00Z")).out).toBe("results/loadtest-2026-11-21-workers4.json");
    expect(() => parseArgs(["--rate", "x"], {})).toThrow();
  });
  it("buildBatch makes unique events", () => {
    const b = buildBatch("r", 10, 3, 5);
    expect(b.map((e) => e.seq)).toEqual([10, 11, 12]);
    expect(new Set(b.map((e) => e.message)).size).toBe(3);
  });
});

describe("chart", () => {
  it("renders self-contained html", () => {
    const result = {
      config: { workers: 1 },
      throughput: { sendRate: 100, processedPerSec: 99, perSecond: [{ t: 0, sent: 100, processed: 90 }, { t: 1, sent: 100, processed: 100 }] },
      latencyMs: { e2e: summarize([10, 20, 30]) },
      lost: 0,
      targets: { met: true },
      measurement: "m",
    };
    const html = renderChart([{ label: "a<b", result }]);
    expect(html).toContain("<svg");
    expect(html).toContain("a&lt;b");
    expect(html).not.toMatch(/<script|src=|href=/);
  });
});

describe("coverage", () => {
  it("targets fail when push coverage is incomplete", () => {
    expect(evaluateTargets(summarize([10, 20]), 0, false).met).toBe(false);
  });
});

describe("repeat aggregation", () => {
  const mk = (p50, p99, proc, lost = 0) => ({
    date: "d", commit: "c", config: { workers: 1 }, sent: 100, accepted: 100, rejected: 0, httpErrors: 0, alertsSeen: 100 - lost, lost,
    wallTimeSec: 10, e2eCoverage: 1,
    throughput: { targetRate: 100, sendRate: 100, processedPerSec: proc, perSecond: [{ t: 0, sent: 1, processed: 1 }] },
    latencyMs: { e2e: { p50, p90: p50, p99, max: p99, mean: p50, count: 100 }, e2eSource: "ui-push", alertStream: summarize([1]), notification: null },
    measurement: "m",
  });
  it("median handles odd, even and empty", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
  });
  it("aggregates medians, sums and ranges", () => {
    const a = aggregateRuns([mk(10, 5000, 90), mk(20, 100, 100), mk(30, 200, 95)]);
    expect(a.latencyMs.e2e).toMatchObject({ p50: 20, p99: 200, count: 300 });
    expect(a.sent).toBe(300);
    expect(a.throughput.processedPerSec).toBe(95);
    expect(a.aggregate).toMatchObject({ repeats: 3, method: "median of per-run values" });
    expect(a.aggregate.range.e2e.p99).toEqual([100, 5000]);
    expect(a.aggregate.range.processedPerSec).toEqual([90, 100]);
    expect(a.runs).toHaveLength(3);
    expect(a.targets.met).toBe(true);
    expect(aggregateRuns([mk(10, 100, 1), mk(10, 100, 1, 1)]).targets.met).toBe(false);
  });
  it("parseArgs repeat defaults", () => {
    expect(parseArgs([], {}).repeat).toBe(3);
    expect(parseArgs(["--smoke"], {}).repeat).toBe(1);
    expect(parseArgs(["--repeat", "5"], {}).repeat).toBe(5);
    expect(parseArgs(["--smoke"], {}, new Date("2026-11-21T10:00:00Z")).out).toBe("results/smoke/loadtest-2026-11-21.json");
  });
});

describe("backlog and overload", () => {
  it("parses XINFO GROUPS and sums lag and pending", () => {
    const g = parseGroups([["name", "engine", "consumers", 2, "pending", 5, "last-delivered-id", "1-0", "entries-read", 10, "lag", 7]]);
    expect(g.engine).toEqual({ lag: 7, pending: 5, entriesRead: 10 });
    expect(groupBacklog(g.engine, null)).toBe(12);
    expect(groupBacklog(undefined, null)).toBe(0);
  });
  it("estimates lag from counters when Redis reports nil", () => {
    expect(groupBacklog({ lag: null, pending: 1, entriesRead: 90 }, 100)).toBe(11);
    expect(groupBacklog({ lag: null, pending: 0, entriesRead: null }, null)).toBe(0);
  });
  it("aggregate keeps overload, backlog and completed windows; backlog fails targets", () => {
    const base = {
      date: "d", commit: "c", config: {}, sent: 10, accepted: 10, rejected: 0, httpErrors: 0, alertsSeen: 5, unprocessedAtEnd: 5, backlogAtEnd: 5,
      overloaded: true, lost: 0, wallTimeSec: 1, e2eCoverage: 1,
      throughput: { targetRate: 1, sendRate: 1, processedPerSec: 1, perSecond: [] },
      latencyMs: { e2e: summarize([1, 2]), e2eSource: "ui-push", alertStream: summarize([1]), notification: null },
      measurement: "m",
    };
    const a = aggregateRuns([base], 3);
    expect(a).toMatchObject({ overloaded: true, windowsCompleted: 1, windowsPlanned: 3, backlogAtEnd: 5, unprocessedAtEnd: 5, lost: 0 });
    expect(a.targets.met).toBe(false);
    expect(evaluateTargets(summarize([1]), 0, true, 3).met).toBe(false);
    expect(parseArgs(["--preflight-timeout", "30"], {}).preflightTimeout).toBe(30);
  });
});

describe("cleanup", () => {
  it("purgeRedisPattern scans and unlinks in batches", async () => {
    const pages = [["5", Array.from({ length: 2500 }, (_, i) => `k${i}`)], ["0", ["x", "y"]]];
    const unlinked = [];
    const redis = {
      scan: async () => pages.shift(),
      unlink: async (...keys) => {
        unlinked.push(keys.length);
        return keys.length;
      },
    };
    expect(await purgeRedisPattern(redis, "p*", 1000)).toBe(2502);
    expect(unlinked).toEqual([1000, 1000, 500, 2]);
  });
  it("only targets lt-tmp- data", () => {
    for (const p of REDIS_PATTERNS) expect(p).toContain("lt-tmp-*");
    for (const [, sql] of PG_STATEMENTS) expect(sql).toContain("LIKE $1");
    expect(PG_STATEMENTS.map(([n]) => n)).toEqual(["alert_audit", "suggestions", "alerts", "events"]);
    expect(parseArgs(["--keep-data", "--cleanup-only"], {})).toMatchObject({ keepData: true, cleanupOnly: true });
  });
});
