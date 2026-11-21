/** Opaque string id (uuid or slug). */
export type Id = string;
/** ISO-8601 timestamp string, e.g. "2026-10-23T09:14:02.331Z". */
export type IsoTimestamp = string;
/** Channel id. Built in: "ui", "ntfy". Kept a string so plugins can add more. */
export type ChannelId = string;
export const BUILTIN_CHANNELS = ["ui", "ntfy"] as const;

export const SEVERITIES = ["info", "warning", "error", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Rank per severity; higher is more severe (critical > error > warning > info). */
export const SEVERITY_ORDER: Record<Severity, number> = {
  info: 0,
  warning: 1,
  error: 2,
  critical: 3,
};

export function isSeverity(v: unknown): v is Severity {
  return typeof v === "string" && (SEVERITIES as readonly string[]).includes(v);
}

/** Negative if a < b, 0 if equal, positive if a > b (by severity order). */
export function compareSeverity(a: Severity, b: Severity): number {
  return SEVERITY_ORDER[a] - SEVERITY_ORDER[b];
}

export const ALERT_STATES = ["open", "acknowledged", "resolved"] as const;
export type AlertState = (typeof ALERT_STATES)[number];
export function isAlertState(v: unknown): v is AlertState {
  return typeof v === "string" && (ALERT_STATES as readonly string[]).includes(v);
}

export const EVENT_STATUSES = ["firing", "resolved"] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

/** The normalised fields every schema maps onto. */
export interface CommonFields {
  severity: Severity;
  title: string;
  source: string;
  environment: string;
  dedupKey: string;
  status: EventStatus;
  occurredAt: IsoTimestamp;
}
export type CommonFieldName = keyof CommonFields;
export const COMMON_FIELD_NAMES: readonly CommonFieldName[] = [
  "severity",
  "title",
  "source",
  "environment",
  "dedupKey",
  "status",
  "occurredAt",
];

/** Arbitrary parsed JSON value. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
