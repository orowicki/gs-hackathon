// Render one or more load test result JSON files into a single self-contained HTML page (inline SVG).
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

const COLOURS = ["#3b82f6", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#64748b"];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmt = (v) => (v === null || v === undefined ? "-" : Number.isInteger(v) ? String(v) : v.toFixed(1));

function lineChart(series, w = 640, h = 260) {
  const m = { l: 56, r: 12, t: 12, b: 28 };
  const maxT = Math.max(1, ...series.flatMap((s) => s.points.map((p) => p.t)));
  const maxY = Math.max(1, ...series.flatMap((s) => s.points.flatMap((p) => [p.sent, p.processed])));
  const x = (t) => m.l + (t / maxT) * (w - m.l - m.r);
  const y = (v) => h - m.b - (v / maxY) * (h - m.t - m.b);
  let g = `<line class="axis" x1="${m.l}" y1="${h - m.b}" x2="${w - m.r}" y2="${h - m.b}"/><line class="axis" x1="${m.l}" y1="${m.t}" x2="${m.l}" y2="${h - m.b}"/>`;
  for (let i = 0; i <= 4; i++) {
    const v = (maxY * i) / 4;
    g += `<text class="lbl" x="${m.l - 6}" y="${y(v) + 4}" text-anchor="end">${Math.round(v)}</text>`;
  }
  g += `<text class="lbl" x="${w - m.r}" y="${h - 8}" text-anchor="end">seconds (${maxT})</text>`;
  series.forEach((s, i) => {
    const c = COLOURS[i % COLOURS.length];
    const path = (key) => s.points.map((p, j) => `${j ? "L" : "M"}${x(p.t).toFixed(1)},${y(p[key]).toFixed(1)}`).join(" ");
    g += `<path d="${path("sent")}" fill="none" stroke="${c}" stroke-width="1.5" stroke-dasharray="4 3" opacity="0.7"/>`;
    g += `<path d="${path("processed")}" fill="none" stroke="${c}" stroke-width="2"/>`;
  });
  return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Throughput per second">${g}</svg>`;
}

function barChart(series, w = 640, h = 260) {
  const m = { l: 56, r: 12, t: 12, b: 28 };
  const keys = ["p50", "p90", "p99", "max"];
  const maxY = Math.max(1, ...series.flatMap((s) => keys.map((k) => s.e2e[k] ?? 0)));
  const y = (v) => h - m.b - (v / maxY) * (h - m.t - m.b);
  const groupW = (w - m.l - m.r) / keys.length;
  const barW = Math.min(36, (groupW - 12) / Math.max(1, series.length));
  let g = `<line class="axis" x1="${m.l}" y1="${h - m.b}" x2="${w - m.r}" y2="${h - m.b}"/>`;
  for (let i = 0; i <= 4; i++) {
    const v = (maxY * i) / 4;
    g += `<text class="lbl" x="${m.l - 6}" y="${y(v) + 4}" text-anchor="end">${Math.round(v)} ms</text>`;
  }
  keys.forEach((k, ki) => {
    const gx = m.l + ki * groupW + (groupW - barW * series.length) / 2;
    g += `<text class="lbl" x="${m.l + ki * groupW + groupW / 2}" y="${h - 8}" text-anchor="middle">${k}</text>`;
    series.forEach((s, si) => {
      const v = s.e2e[k] ?? 0;
      g += `<rect x="${(gx + si * barW).toFixed(1)}" y="${y(v).toFixed(1)}" width="${(barW - 2).toFixed(1)}" height="${(h - m.b - y(v)).toFixed(1)}" fill="${COLOURS[si % COLOURS.length]}"><title>${esc(s.label)} ${k}: ${fmt(v)} ms</title></rect>`;
    });
  });
  return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="End-to-end latency percentiles">${g}</svg>`;
}

/** results: [{label, result}] -> HTML string. */
export function renderChart(results) {
  const series = results.map(({ label, result: r }) => ({
    label,
    points: r.throughput?.perSecond ?? [],
    e2e: r.latencyMs?.e2e ?? {},
  }));
  const legend = series
    .map((s, i) => `<span class="key"><i style="background:${COLOURS[i % COLOURS.length]}"></i>${esc(s.label)}</span>`)
    .join("");
  const rows = results
    .map(({ label, result: r }) => {
      const e = r.latencyMs?.e2e ?? {};
      return `<tr><td>${esc(label)}</td><td>${fmt(r.config?.workers)}</td><td>${fmt(r.throughput?.sendRate)}</td><td>${fmt(r.throughput?.processedPerSec)}</td><td>${fmt(e.p50)}</td><td>${fmt(e.p99)}</td><td>${fmt(r.lost)}</td><td class="${r.targets?.met ? "ok" : "bad"}">${r.targets?.met ? "yes" : "no"}</td></tr>`;
    })
    .join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Load test results</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1f2937;--mute:#6b7280;--line:#d1d5db}
@media (prefers-color-scheme:dark){:root{--bg:#111827;--fg:#e5e7eb;--mute:#9ca3af;--line:#374151}}
body{font:14px system-ui,sans-serif;background:var(--bg);color:var(--fg);margin:2rem auto;max-width:720px;padding:0 1rem}
table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid var(--line);padding:.35rem .5rem;text-align:right}
th:first-child,td:first-child{text-align:left}.ok{color:#10b981}.bad{color:#ef4444}
svg{width:100%;height:auto}.axis{stroke:var(--line)}.lbl{fill:var(--mute);font-size:11px}
.key{margin-right:1rem}.key i{display:inline-block;width:.8em;height:.8em;margin-right:.3em;border-radius:2px}
p.note{color:var(--mute)}
</style></head><body>
<h1>Load test results</h1>
<p>${legend}</p>
<table><thead><tr><th>run</th><th>workers</th><th>send/s</th><th>processed/s</th><th>p50 ms</th><th>p99 ms</th><th>lost</th><th>targets met</th></tr></thead><tbody>${rows}</tbody></table>
<h2>Throughput per second</h2><p class="note">Solid: alerts processed. Dashed: events sent.</p>
${lineChart(series)}
<h2>End-to-end latency</h2>
${barChart(series)}
<p class="note">${esc(results[0]?.result.measurement ?? "")}</p>
</body></html>
`;
}

export function writeChart(outFile, resultFiles) {
  const results = resultFiles.map((f) => ({ label: basename(f, ".json"), result: JSON.parse(readFileSync(f, "utf8")) }));
  writeFileSync(outFile, renderChart(results));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const i = args.indexOf("--out");
  const out = i >= 0 ? args[i + 1] : undefined;
  const files = args.filter((a, j) => j !== i && j !== i + 1);
  if (!out || files.length === 0) {
    console.error("usage: node scripts/loadtest/chart.mjs --out <file.html> <result1.json> [result2.json ...]");
    process.exit(2);
  }
  writeChart(out, files);
  console.log(`wrote ${out}`);
}
