import type { QuietHours } from "@alerting/shared";

function minutes(hhmm: string): number | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return undefined;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 24 || mi > 59) return undefined;
  return h * 60 + mi;
}

/** Minutes since local midnight in an IANA timezone. Throws RangeError for an unknown timezone. */
export function localMinutes(now: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
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
