/**
 * Dates in filters: `>`, `>=`, `<`, `<=` compare as times when the value is a date literal.
 * Accepted literals: `now`, `now-24h`, `now+30m` (units s, m, h, d, w), or an ISO date such as
 * `2026-11-21` / `2026-11-21T09:00:00Z`. The field side may be an ISO string or an epoch (s or ms).
 */
export const RELATIVE_TIME_RE = /^now(?:([+-])(\d+)([smhdw]))?$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;
const UNIT_MS: Record<string, number> = { s: 1e3, m: 6e4, h: 3.6e6, d: 8.64e7, w: 6.048e8 };

/** Epoch ms for a filter literal that is a date (`now-24h`, ISO), else undefined. */
export function parseTimeValue(lit: unknown, now: number): number | undefined {
  if (typeof lit !== "string") return undefined;
  const t = lit.trim();
  const rel = RELATIVE_TIME_RE.exec(t);
  if (rel) {
    if (!rel[1]) return now;
    const delta = Number(rel[2]) * UNIT_MS[rel[3]!.toLowerCase()]!;
    return rel[1] === "-" ? now - delta : now + delta;
  }
  if (!ISO_DATE_RE.test(t)) return undefined;
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? undefined : ms;
}

/** Epoch ms for a field value: ISO string, or epoch seconds / ms (9+ integer digits; below 1e11 = seconds). */
export function toEpochMs(v: unknown): number | undefined {
  if (typeof v === "number" || (typeof v === "string" && /^\d{9,}(\.\d+)?$/.test(v.trim()))) {
    const n = Number(v);
    if (!Number.isFinite(n) || Math.abs(n) < 1e8) return undefined;
    return Math.abs(n) < 1e11 ? n * 1000 : n;
  }
  if (typeof v === "string" && ISO_DATE_RE.test(v.trim())) {
    const ms = Date.parse(v.trim());
    return Number.isNaN(ms) ? undefined : ms;
  }
  return undefined;
}
