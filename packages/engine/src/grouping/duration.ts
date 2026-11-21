const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

/** "500ms", "30s", "5m", "1h" -> milliseconds; null when invalid or zero. */
export function parseDuration(s: unknown): number | null {
  if (typeof s !== "string") return null;
  const m = /^(\d+)(ms|s|m|h)$/.exec(s.trim());
  if (!m) return null;
  const ms = Number(m[1]) * UNITS[m[2]!]!;
  return Number.isSafeInteger(ms) && ms > 0 ? ms : null;
}
