import { SEVERITIES, type EventStatus, type Severity } from "@alerting/shared";

/**
 * Numeric strings become numbers ("12.5" -> 12.5); everything else is returned unchanged.
 * Use it on raw parsed values before filter comparison if numeric semantics are wanted.
 * Common string fields (title, source, ...) are never passed through it.
 */
export function normaliseValue(v: unknown): unknown {
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return v;
}

/** Deep copy of a parsed value with `normaliseValue` applied to every string leaf. */
export function normaliseDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normaliseDeep);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normaliseDeep(x)]));
  }
  return normaliseValue(v);
}

/**
 * ISO string, epoch seconds or epoch ms (number or numeric string) -> ISO `toISOString()`.
 * Numbers below 1e11 are seconds, otherwise milliseconds. Unparseable -> undefined.
 */
export function normaliseTimestamp(v: unknown): string | undefined {
  let d: Date;
  const n = typeof v === "number" ? v : typeof v === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(v) ? Number(v) : undefined;
  if (n !== undefined) {
    if (!Number.isFinite(n)) return undefined;
    d = new Date(Math.abs(n) < 1e11 ? n * 1000 : n);
  } else if (typeof v === "string" && v.trim() !== "") {
    d = new Date(v);
  } else return undefined;
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

const SEVERITY_ALIASES: Record<string, Severity> = {
  warn: "warning",
  crit: "critical",
  err: "error",
  fatal: "critical",
  information: "info",
};

/** Case-insensitive severity with a few aliases; unknown -> undefined. */
export function normaliseSeverity(v: unknown): Severity | undefined {
  if (typeof v !== "string") return undefined;
  const k = v.trim().toLowerCase();
  if ((SEVERITIES as readonly string[]).includes(k)) return k as Severity;
  return Object.hasOwn(SEVERITY_ALIASES, k) ? SEVERITY_ALIASES[k] : undefined;
}

/** Case-insensitive firing|resolved; anything else -> undefined (field omitted). */
export function normaliseStatus(v: unknown): EventStatus | undefined {
  if (typeof v !== "string") return undefined;
  const k = v.trim().toLowerCase();
  return k === "firing" || k === "resolved" ? k : undefined;
}
