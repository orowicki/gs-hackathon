import { SEVERITIES, type EventStatus, type Severity } from "@alerting/shared";

const CANONICAL_DECIMAL = /^-?(0|[1-9]\d*)(\.\d+)?$/;

/**
 * Canonical numeric strings become numbers ("12.5" -> 12.5); everything else is unchanged.
 * Canonical: optional `-`, no leading zeros (except `0` / `0.x`), no `+`, no exponent, no
 * whitespace, finite, integers within the safe-integer range. So "007", "+1", "1e3", " 5" and
 * long digit strings (ids) stay strings.
 */
export function normaliseValue(v: unknown): unknown {
  if (typeof v === "string" && CANONICAL_DECIMAL.test(v)) {
    const n = Number(v);
    if (!Number.isFinite(n) || Object.is(n, -0)) return v;
    if (!v.includes(".") && !Number.isSafeInteger(n)) return v;
    return n;
  }
  return v;
}

/** Deep copy of a parsed value with `normaliseValue` applied to every string leaf. */
export function normaliseDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normaliseDeep);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [k, normaliseDeep(x)]),
    );
  }
  return normaliseValue(v);
}

const EPOCH_STRING = /^\d{9,}(\.\d+)?$/;
const DIGITS = /^-?\d+(\.\d+)?$/;

/**
 * ISO string, epoch seconds or epoch ms -> ISO `toISOString()`. Numbers below 1e11 are seconds,
 * otherwise milliseconds. Numbers and numeric strings count as epoch only with >= 9 integer digits (so "2026" or
 * "20261023" are omitted, never 1970 dates). Unparseable -> undefined.
 */
export function normaliseTimestamp(v: unknown): string | undefined {
  let d: Date;
  let n: number | undefined;
  if (typeof v === "number") {
    if (Math.abs(v) < 1e8) return undefined; // fewer than 9 integer digits: not an epoch
    n = v;
  } else if (typeof v === "string") {
    const t = v.trim();
    if (EPOCH_STRING.test(t)) n = Number(t);
    else if (DIGITS.test(t)) return undefined;
  }
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
