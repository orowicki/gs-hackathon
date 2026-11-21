import type { AlertState, CommonFields, Id, IsoTimestamp, Severity } from "./common.js";

export interface Alert {
  id: Id;
  ruleId: Id;
  /** Event that opened the alert. */
  eventId: Id;
  schemaId: Id | null;
  dedupKey: string;
  state: AlertState;
  severity: Severity;
  title: string;
  body?: string;
  source: string;
  environment: string;
  /** Number of events folded into this alert. */
  count: number;
  firstSeen: IsoTimestamp;
  lastSeen: IsoTimestamp;
  acknowledgedBy?: Id;
  acknowledgedAt?: IsoTimestamp;
  resolvedAt?: IsoTimestamp;
  resolvedBy?: Id;
  /** What the resolver wrote about how it was fixed. */
  resolution?: string;
  /** Rendered `looks.fields`, in order. */
  fields: Array<{ label: string; value: string }>;
  colour?: string;
  /** Common fields of the latest event, for filters. */
  common: Partial<CommonFields>;
}

export interface AuditEntry {
  id: Id;
  alertId: Id;
  at: IsoTimestamp;
  /** Person id or "system". */
  actor: string;
  action: "created" | "acknowledged" | "unacknowledged" | "resolved" | "step_executed" | "step_approved" | "step_skipped" | "escalated" | "suggestion";
  runbookId?: Id;
  stepIndex?: number;
  result?: string;
  detail?: string;
}

export interface Suggestion {
  id: Id;
  ruleId: Id;
  alertId?: Id;
  author: Id;
  text: string;
  status: "open" | "accepted" | "dismissed";
  createdAt: IsoTimestamp;
}

/** The rulebook: one "how to resolve" text per rule, written by people when they resolve alerts. */
/** One "how to resolve" comment on a rule; a rule keeps all of them, oldest first. */
export interface RulebookEntry {
  id: Id;
  ruleId: Id;
  text: string;
  updatedBy: Id;
  updatedAt: IsoTimestamp;
  /** Alert whose resolution produced this text. */
  alertId?: Id;
}
