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

export function evaluateTargets(e2e, lost) {
  const met = e2e.count > 0 && e2e.p50 <= TARGETS.p50 && e2e.p99 <= TARGETS.p99 && lost <= TARGETS.lost;
  return { ...TARGETS, met };
}
