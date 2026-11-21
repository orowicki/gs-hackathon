import type { QuietHours } from "@alerting/shared";

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function minutes(hhmm: string): number | undefined {
  const m = HHMM.exec(hhmm.trim());
  if (!m) return undefined;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Validates a quiet-hours window; returns an error message or undefined when valid. */
export function quietHoursError(q: QuietHours): string | undefined {
  if (minutes(q.from) === undefined || minutes(q.to) === undefined) return `invalid quiet hours ${q.from}-${q.to}`;
  try {
    formatter(q.timezone);
  } catch {
    return `unknown timezone ${q.timezone}`;
  }
  return undefined;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timezone: string): Intl.DateTimeFormat {
  let f = formatters.get(timezone);
  if (!f) {
    // throws RangeError for an unknown timezone (not cached)
    f = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    formatters.set(timezone, f);
  }
  return f;
}

/** Minutes since local midnight in an IANA timezone. Throws RangeError for an unknown timezone. */
export function localMinutes(now: Date, timezone: string): number {
  const parts = formatter(timezone).formatToParts(now);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

/** True when `now` is in [from, to) local to the timezone; windows may wrap midnight. */
export function inQuietHours(q: QuietHours, now: Date): boolean {
  const from = minutes(q.from);
  const to = minutes(q.to);
  if (from === undefined || to === undefined) throw new Error(`invalid quiet hours ${q.from}-${q.to}`);
  if (from === to) return false;
  const t = localMinutes(now, q.timezone);
  return from < to ? t >= from && t < to : t >= from || t < to;
}
