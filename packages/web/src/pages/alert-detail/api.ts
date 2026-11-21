/** Minimal local types (packages/web does not depend on @alerting/shared). Tolerant of field-name drift. */
export type Lifecycle = "open" | "acknowledged" | "resolved";

export interface Alert {
  id: string;
  title?: string;
  severity?: string;
  source?: string;
  environment?: string;
  dedupKey?: string;
  body?: string;
  count?: number;
  firstSeen?: string;
  lastSeen?: string;
  /** Lifecycle in the newer spec; older shape used `state`. */
  status?: string;
  state?: string;
  common?: Record<string, unknown>;
  /** The stored event, if the API embeds it. */
  event?: { raw?: unknown; parsed?: unknown } | Record<string, unknown>;
  parsed?: unknown;
  raw?: unknown;
  fields?: Array<{ label: string; value: string }>;
  ruleId?: string;
  resolvedAt?: string;
  resolvedBy?: string;
  acknowledgedAt?: string;
  acknowledgedBy?: string;
  /** What the resolver wrote. */
  resolution?: string;
  /** The rule's "how to resolve" comments, oldest first. */
  rulebook?: RulebookEntry[] | null;
  [key: string]: unknown;
}

export interface RulebookEntry {
  id: string;
  ruleId: string;
  text: string;
  updatedBy: string;
  updatedAt: string;
  alertId?: string;
}

export interface ResolveInput {
  resolution?: string;
  /** Save the resolution as the rule's rulebook text. */
  contribute?: boolean;
}

export interface RunbookRun {
  alertId?: string;
  runbookId: string;
  runbookName?: string;
  /** running | waiting | done | failed (as the runner reports it). */
  status?: string;
  steps: Array<{ index: number; state: string; result?: string; at?: string; name?: string }>;
}

export interface AuditEntry {
  id?: string;
  at: string;
  actor: string;
  action: string;
  result?: string;
  detail?: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown, yaml = false): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": yaml ? "application/yaml" : "application/json" },
    body: body === undefined ? undefined : yaml ? String(body) : JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try {
      const data = (await res.json()) as { error?: unknown; message?: unknown };
      const m = data.error ?? data.message;
      if (typeof m === "string" && m) msg = m;
    } catch {
      /* keep default message */
    }
    throw new ApiError(res.status, msg);
  }
  return (await res.json()) as T;
}

const base = (id: string) => `/api/alerts/${encodeURIComponent(id)}`;

export const getAlert = (id: string) => request<Alert>("GET", base(id));
export const ackAlert = (id: string) => request<Alert>("POST", `${base(id)}/ack`);
export const unackAlert = (id: string) => request<Alert>("POST", `${base(id)}/unack`);
export const resolveAlert = (id: string, input: ResolveInput = {}) => request<Alert>("POST", `${base(id)}/resolve`, input);
/** A runbook that applies to this alert (text filled in, step names rendered). */
export interface MatchedRunbook {
  id: string;
  name: string;
  type: "text" | "automation";
  origin: "rule" | "config";
  content?: string;
  steps?: Array<{ index: number; name: string; action: string; approval: string }>;
}
export const getMatchedRunbooks = (id: string) => listOrEmpty<MatchedRunbook>(`${base(id)}/runbooks`);

/** Start an automation runbook on this alert now. */
export const startRunbook = (id: string, runbookId: string) =>
  request<RunbookRun>("POST", `${base(id)}/runbook-runs`, { runbookId });
export const decideStep = (id: string, runbookId: string, stepIndex: number, decision: "approve" | "skip") =>
  request<RunbookRun>("POST", `${base(id)}/runbook-steps/${stepIndex}/approve`, { runbookId, decision });

export const addRulebookComment = (id: string, text: string) =>
  request<RulebookEntry>("POST", `${base(id)}/rulebook`, { text });

/** The rule's own runbook: YAML for editing plus the stored runbook. */
export interface RuleRunbook {
  runbook: { id: string; name: string; type: "text" | "automation"; content?: string; steps?: Array<Record<string, unknown>> };
  yaml: string;
}
const ruleRunbookUrl = (ruleId: string) => `/api/rules/${encodeURIComponent(ruleId)}/runbook`;
/** null when the rule has no runbook yet. */
export async function getRuleRunbook(ruleId: string): Promise<RuleRunbook | null> {
  try {
    return await request<RuleRunbook>("GET", ruleRunbookUrl(ruleId));
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}
export const putRuleRunbook = (ruleId: string, yaml: string) => request<RuleRunbook>("PUT", ruleRunbookUrl(ruleId), yaml, true);

export const sendSuggestion = (id: string, text: string) => request<unknown>("POST", `${base(id)}/suggestions`, { text });

/** Never throws: missing routes (404) and failures both yield an empty list. */
async function listOrEmpty<T>(url: string): Promise<T[]> {
  try {
    const data = await request<unknown>("GET", url);
    return Array.isArray(data) ? (data as T[]) : [];
  } catch {
    return [];
  }
}
export const getRunbookRuns = (id: string) => listOrEmpty<RunbookRun>(`${base(id)}/runbook-runs`);
export const getAudit = (id: string) => listOrEmpty<AuditEntry>(`${base(id)}/audit`);

const isLifecycle = (v: unknown): v is Lifecycle => v === "open" || v === "acknowledged" || v === "resolved";

export function lifecycleOf(a: Alert): Lifecycle {
  // `state` is what ack/unack/resolve change; `status` is a copy the engine writes at creation.
  if (isLifecycle(a.state)) return a.state;
  if (isLifecycle(a.status)) return a.status;
  return "open";
}

export function sourceStatusOf(a: Alert): string | undefined {
  const c = a.common ?? {};
  const v = c.sourceStatus ?? (isLifecycle(c.status) ? undefined : c.status);
  if (typeof v === "string" && v) return v;
  if (typeof a.status === "string" && !isLifecycle(a.status) && a.status) return a.status;
  return undefined;
}

/** Where the raw event lives: embedded event.parsed / event.raw / event itself, else top-level parsed/raw. */
export function eventOf(a: Alert): Record<string, unknown> | null {
  const obj = (v: unknown): Record<string, unknown> | null =>
    typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  const ev = obj(a.event);
  if (ev) {
    const inner = obj(ev.parsed) ?? obj(ev.raw);
    if (inner) return inner;
    if (!("sourceId" in ev && "receivedAt" in ev)) return ev;
  }
  return obj(a.parsed) ?? obj(a.raw);
}
