// Pure helpers for the load test: percentiles, histogram buckets, per-second series.

/** Nearest-rank percentile (p in 0..100) of an array of numbers; null when empty. */
export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = Float64Array.from(values).sort();
  return percentileSorted(sorted, p);
}

function percentileSorted(sorted, p) {
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/** {p50, p90, p99, max, mean, count}; all null (count 0) for empty input. */
export function summarize(values) {
  if (values.length === 0) return { p50: null, p90: null, p99: null, max: null, mean: null, count: 0 };
  const sorted = Float64Array.from(values).sort();
  let sum = 0;
  for (const v of sorted) sum += v;
  const r = (x) => Math.round(x * 100) / 100;
  return {
    p50: r(percentileSorted(sorted, 50)),
    p90: r(percentileSorted(sorted, 90)),
    p99: r(percentileSorted(sorted, 99)),
    max: r(sorted[sorted.length - 1]),
    mean: r(sum / sorted.length),
    count: sorted.length,
  };
}

/**
 * Histogram counts. `edges` ascending upper bounds; a value goes in the first bucket with
 * value <= edge, the last bucket (edge Infinity) catches the rest.
 * Returns [{le, count}].
 */
export function histogram(values, edges) {
  const buckets = [...edges, Infinity].map((le) => ({ le, count: 0 }));
  for (const v of values) {
    const b = buckets.find((x) => v <= x.le);
    b.count++;
  }
  return buckets;
}

/**
 * Per-second series. `sent` and `processed` are arrays of epoch-ms timestamps, `start` the epoch ms
 * of second 0. Returns [{t, sent, processed}] for t = 0..last non-empty second (timestamps before start go to 0).
 */
export function perSecondSeries(sent, processed, start) {
  const bucket = (ts) => Math.max(0, Math.floor((ts - start) / 1000));
  let last = -1;
  const s = new Map();
  const p = new Map();
  for (const ts of sent) {
    const b = bucket(ts);
    s.set(b, (s.get(b) ?? 0) + 1);
    last = Math.max(last, b);
  }
  for (const ts of processed) {
    const b = bucket(ts);
    p.set(b, (p.get(b) ?? 0) + 1);
    last = Math.max(last, b);
  }
  const out = [];
  for (let t = 0; t <= last; t++) out.push({ t, sent: s.get(t) ?? 0, processed: p.get(t) ?? 0 });
  return out;
}

/** Targets from the issue: p50 < 50 ms, p99 < 250 ms, nothing lost. */
export const TARGETS = { p50: 50, p99: 250, lost: 0 };

export function evaluateTargets(e2e, lost, coverageOk = true) {
  const met = coverageOk && e2e.count > 0 && e2e.p50 <= TARGETS.p50 && e2e.p99 <= TARGETS.p99 && lost <= TARGETS.lost;
  return { ...TARGETS, met };
}

/** Median of the finite numbers in `values`; null when there are none. Even counts average the middle two. */
export function median(values) {
  const v = values.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

const round2 = (x) => (x === null ? null : Math.round(x * 100) / 100);
const range = (values) => {
  const v = values.filter((x) => typeof x === "number" && Number.isFinite(x));
  return v.length ? [Math.min(...v), Math.max(...v)] : null;
};

/** Per-field medians of latency summaries ({p50,p90,p99,max,mean,count}); null if no run has one. */
export function medianSummary(summaries) {
  const ok = summaries.filter((x) => x && x.count > 0);
  if (ok.length === 0) return summaries.some((x) => x) ? summarize([]) : null;
  const out = { count: ok.reduce((n, x) => n + x.count, 0) };
  for (const k of ["p50", "p90", "p99", "max", "mean"]) out[k] = round2(median(ok.map((x) => x[k])));
  return { p50: out.p50, p90: out.p90, p99: out.p99, max: out.max, mean: out.mean, count: out.count };
}

/**
 * Merge per-run result objects (as produced by run.mjs) into one result: latency/throughput fields are medians
 * across runs, counts are sums, `runs` keeps the full per-run objects, `aggregate` documents the method and ranges.
 */
export function aggregateRuns(runs) {
  const first = runs[0];
  const sum = (k) => runs.reduce((n, r) => n + (r[k] ?? 0), 0);
  const e2e = medianSummary(runs.map((r) => r.latencyMs.e2e));
  const lost = sum("lost");
  const coverageOk = runs.every((r) => r.e2eCoverage >= 1);
  const e2eCoverage = Math.min(...runs.map((r) => r.e2eCoverage));
  const sendRate = round2(median(runs.map((r) => r.throughput.sendRate)));
  const processedPerSec = round2(median(runs.map((r) => r.throughput.processedPerSec)));
  return {
    date: first.date,
    commit: first.commit,
    config: { ...first.config, repeat: runs.length },
    sent: sum("sent"),
    accepted: sum("accepted"),
    rejected: sum("rejected"),
    httpErrors: sum("httpErrors"),
    alertsSeen: sum("alertsSeen"),
    lost,
    wallTimeSec: round2(sum("wallTimeSec")),
    throughput: {
      targetRate: first.throughput.targetRate,
      sendRate,
      processedPerSec,
      // per-second series of the first run (the full series of every run is in `runs`)
      perSecond: first.throughput.perSecond,
    },
    latencyMs: {
      e2e,
      e2eSource: first.latencyMs.e2eSource,
      alertStream: medianSummary(runs.map((r) => r.latencyMs.alertStream)),
      notification: medianSummary(runs.map((r) => r.latencyMs.notification)),
    },
    e2eCoverage,
    targets: evaluateTargets(e2e, lost, coverageOk),
    aggregate: {
      repeats: runs.length,
      method: "median of per-run values",
      range: {
        e2e: {
          p50: range(runs.map((r) => r.latencyMs.e2e.p50)),
          p99: range(runs.map((r) => r.latencyMs.e2e.p99)),
        },
        processedPerSec: range(runs.map((r) => r.throughput.processedPerSec)),
      },
    },
    measurement: first.measurement,
    runs,
  };
}
