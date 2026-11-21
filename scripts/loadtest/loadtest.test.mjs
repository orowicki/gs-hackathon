import { describe, expect, it } from "vitest";
import { renderChart } from "./chart.mjs";
import { buildBatch, parseArgs } from "./run.mjs";
import { evaluateTargets, histogram, percentile, perSecondSeries, summarize } from "./stats.mjs";

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
