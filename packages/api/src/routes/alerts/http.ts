import type http from "node:http";
import type { Alert, AuditEntry, Event, RulebookEntry } from "@alerting/shared";
import { tryParse, validateTree, evaluate, type FilterNode } from "@alerting/filter";
import {
  BodyError,
  sendBodyError,
  decodeSegment,
  newId,
  nowIso,
  parseLimit,
  readJsonBody,
  resolveActor,
  sendJson,
  type AlertsApiDeps,
} from "../common.js";
import { createSuggestion } from "../suggestions/http.js";
import { alertContext } from "./filter-context.js";
import type { AlertCursor, AlertSort, AuditCursor, SortOrder } from "./store.js";
import { computeSummary } from "./summary.js";

export type { AlertsApiDeps } from "../common.js";

const BATCH = 200;
const SCAN_CAP = 5000;

function encodeCursor(a: { lastSeen: string; id: string }): string {
  return Buffer.from(JSON.stringify({ lastSeen: a.lastSeen, id: a.id })).toString("base64url");
}

function decodeCursor(s: string): AlertCursor | null {
  try {
    const v = JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as Partial<AlertCursor>;
    if (typeof v.lastSeen === "string" && typeof v.id === "string" && !Number.isNaN(Date.parse(v.lastSeen)))
      return { lastSeen: v.lastSeen, id: v.id };
  } catch {
    /* fall through */
  }
  return null;
}

function encodeAuditCursor(e: { at: string; id: string }): string {
  return Buffer.from(JSON.stringify({ at: e.at, id: e.id })).toString("base64url");
}

/** Opaque base64url cursor, or (back-compat) a plain ISO timestamp. */
function decodeAuditCursor(s: string): AuditCursor | null {
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    // Plain timestamp: everything strictly older, regardless of id.
    return Number.isNaN(Date.parse(s)) ? null : { at: s, id: "" };
  }
  try {
    const v = JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as Partial<AuditCursor>;
    if (typeof v.at === "string" && typeof v.id === "string" && !Number.isNaN(Date.parse(v.at)))
      return { at: v.at, id: v.id };
  } catch {
    /* fall through */
  }
  return null;
}

function treeFields(n: FilterNode, out: Set<string> = new Set()): Set<string> {
  if (n.type === "and" || n.type === "or") n.children.forEach((c) => treeFields(c, out));
  else if (n.type === "not") treeFields(n.child, out);
  else out.add(n.field);
  return out;
}

type TreeResult = { tree: FilterNode | null } | { status: 400; body: Record<string, unknown> };

/** `filter` (text) wins over `tree` (JSON), exactly as for the list. */
function parseTree(sp: URLSearchParams): TreeResult {
  const filterText = sp.get("filter");
  const treeText = sp.get("tree");
  if (filterText !== null && filterText.trim() !== "") {
    const r = tryParse(filterText);
    if (!r.ok) return { status: 400, body: { error: r.error.message, position: r.error.position } };
    return { tree: r.tree };
  }
  if (treeText !== null) {
    let raw: unknown;
    try {
      raw = JSON.parse(treeText);
    } catch {
      return { status: 400, body: { error: "tree is not valid JSON" } };
    }
    try {
      return { tree: validateTree(raw) };
    } catch (e) {
      return { status: 400, body: { error: e instanceof Error ? e.message : "invalid tree" } };
    }
  }
  return { tree: null };
}

const SORTS = ["lastSeen", "firstSeen", "severity", "count"];

async function summaryRoute(res: http.ServerResponse, url: URL, deps: AlertsApiDeps): Promise<void> {
  const t = parseTree(url.searchParams);
  if ("status" in t) return sendJson(res, 400, t.body);
  const needsEvents = !!t.tree && !!deps.events && [...treeFields(t.tree)].some((f) => !f.startsWith("alert."));
  sendJson(res, 200, await computeSummary(deps, t.tree, needsEvents));
}

async function listAlerts(res: http.ServerResponse, url: URL, deps: AlertsApiDeps): Promise<void> {
  const sp = url.searchParams;
  const t = parseTree(sp);
  if ("status" in t) return sendJson(res, 400, t.body);
  const tree = t.tree;
  const stateParam = sp.get("state");
  if (stateParam !== null && !["open", "acknowledged", "resolved"].includes(stateParam))
    return sendJson(res, 400, { error: "bad state" });
  const state = (stateParam ?? undefined) as Alert["state"] | undefined;
  const limit = parseLimit(sp.get("limit"), 50, 200);
  let before: AlertCursor | undefined;
  const beforeParam = sp.get("before");
  if (beforeParam) {
    before = decodeCursor(beforeParam) ?? undefined;
    if (!before) return sendJson(res, 400, { error: "bad before cursor" });
  }

  const sortParam = sp.get("sort");
  const orderParam = sp.get("order");
  const offsetParam = sp.get("offset");
  if (sortParam !== null && !SORTS.includes(sortParam)) return sendJson(res, 400, { error: "bad sort" });
  if (orderParam !== null && orderParam !== "asc" && orderParam !== "desc") return sendJson(res, 400, { error: "bad order" });
  let offset = 0;
  if (offsetParam !== null) {
    if (!/^\d+$/.test(offsetParam) || !Number.isSafeInteger(Number(offsetParam)))
      return sendJson(res, 400, { error: "bad offset" });
    offset = Number(offsetParam);
  }
  const sort = (sortParam ?? undefined) as AlertSort | undefined;
  const order = (orderParam ?? undefined) as SortOrder | undefined;
  const custom = (sort ?? "lastSeen") !== "lastSeen" || (order ?? "desc") !== "desc";
  if (before && custom)
    return sendJson(res, 400, { error: "before cursor is only valid with the default sort (lastSeen desc); use offset with a non-default sort" });
  const sortQ = custom ? { sort: sort ?? "lastSeen", order: order ?? "desc" } : {};

  if (!tree) {
    const rows = await deps.alerts.list({ state, before, limit, ...sortQ, offset: custom ? offset || undefined : undefined });
    const headers: Record<string, string> = {};
    if (rows.length === limit) {
      if (custom) headers["x-next-offset"] = String(offset + limit);
      else headers["x-next-before"] = encodeCursor(rows[rows.length - 1]!);
    }
    return sendJson(res, 200, rows, headers);
  }
  if (custom) return listFilteredOffset(res, deps, tree, { state, limit, offset, ...sortQ });

  const needsEvents = !!deps.events && [...treeFields(tree)].some((f) => !f.startsWith("alert."));
  const out: Alert[] = [];
  let scanned = 0;
  let cursor = before;
  let lastScanned: Alert | undefined;
  let exhausted = false;
  scan: while (scanned < SCAN_CAP) {
    const batch = await deps.alerts.list({ state, before: cursor, limit: BATCH });
    if (batch.length === 0) {
      exhausted = true;
      break;
    }
    let events = new Map<string, Event>();
    if (needsEvents) events = await deps.events!.getEvents([...new Set(batch.map((a) => a.eventId))]);
    for (const a of batch) {
      scanned++;
      lastScanned = a;
      if (evaluate(tree, alertContext(a, events.get(a.eventId)))) {
        out.push(a);
        if (out.length >= limit) break scan;
      }
      if (scanned >= SCAN_CAP) break scan;
    }
    if (batch.length < BATCH) {
      exhausted = true;
      break;
    }
    cursor = { lastSeen: batch[batch.length - 1]!.lastSeen, id: batch[batch.length - 1]!.id };
  }
  const headers: Record<string, string> = {};
  if (!exhausted && lastScanned) headers["x-next-before"] = encodeCursor(lastScanned);
  sendJson(res, 200, out, headers);
}

const MAX_RESOLUTION_CHARS = 4000;

/** Filtered list for non-default sorts: scan in sort order, skip `offset` matches, then take `limit`. */
async function listFilteredOffset(
  res: http.ServerResponse,
  deps: AlertsApiDeps,
  tree: FilterNode,
  q: { state?: Alert["state"]; limit: number; offset: number; sort?: AlertSort; order?: SortOrder },
): Promise<void> {
  const needsEvents = !!deps.events && [...treeFields(tree)].some((f) => !f.startsWith("alert."));
  const out: Alert[] = [];
  let skipped = 0;
  let scanned = 0;
  let exhausted = false;
  scan: while (scanned < SCAN_CAP) {
    const batch = await deps.alerts.list({ state: q.state, limit: BATCH, sort: q.sort, order: q.order, offset: scanned });
    if (batch.length === 0) {
      exhausted = true;
      break;
    }
    let events = new Map<string, Event>();
    if (needsEvents) events = await deps.events!.getEvents([...new Set(batch.map((a) => a.eventId))]);
    for (const a of batch) {
      scanned++;
      if (evaluate(tree, alertContext(a, events.get(a.eventId)))) {
        if (skipped < q.offset) skipped++;
        else {
          out.push(a);
          if (out.length >= q.limit) break scan;
        }
      }
      if (scanned >= SCAN_CAP) break scan;
    }
    if (batch.length < BATCH) {
      exhausted = true;
      break;
    }
  }
  const headers: Record<string, string> = {};
  // Only when the page filled up: a cap hit with fewer matches would make clients rescan the same rows forever.
  if (!exhausted && out.length >= q.limit) headers["x-next-offset"] = String(q.offset + out.length);
  sendJson(res, 200, out, headers);
}

const VERB = { acknowledged: "acknowledge", unacknowledged: "unacknowledge", resolved: "resolve" } as const;

async function transition(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: AlertsApiDeps,
  id: string,
  kind: "acknowledged" | "unacknowledged" | "resolved",
): Promise<void> {
  const body = await readJsonBody(req);
  const actor = resolveActor(req, body.actor);
  const at = nowIso(deps);
  let resolution: string | undefined;
  if (kind === "resolved" && body.resolution !== undefined && body.resolution !== null) {
    if (typeof body.resolution !== "string" || body.resolution.length > MAX_RESOLUTION_CHARS)
      return sendJson(res, 400, { error: `resolution must be a string of at most ${MAX_RESOLUTION_CHARS} characters` });
    resolution = body.resolution.trim() || undefined;
  }
  const contribute = kind === "resolved" && body.contribute === true;
  if (contribute && !resolution) return sendJson(res, 400, { error: "contribute needs a resolution text" });
  const entry: AuditEntry = {
    id: newId(deps),
    alertId: id,
    at,
    actor,
    action: kind,
    ...(resolution ? { detail: resolution.slice(0, 200) } : {}),
  };
  // null (not undefined) so the JSON merge in the pg store clears the fields.
  const cleared = { acknowledgedBy: null, acknowledgedAt: null } as unknown as Partial<Alert>;
  const out =
    kind === "acknowledged"
      ? await deps.alerts.transitionWithAudit(
          id,
          ["open"],
          { state: "acknowledged", status: "acknowledged", acknowledgedBy: actor, acknowledgedAt: at } as Partial<Alert>,
          entry,
        )
      : kind === "unacknowledged"
        ? await deps.alerts.transitionWithAudit(id, ["acknowledged"], { state: "open", status: "open", ...cleared } as Partial<Alert>, entry)
        : await deps.alerts.transitionWithAudit(
          id,
          ["open", "acknowledged"],
          { state: "resolved", status: "resolved", resolvedAt: at, resolvedBy: actor, ...(resolution ? { resolution } : {}) } as Partial<Alert>,
          entry,
        );
  if (out === null) return sendJson(res, 404, { error: "alert not found" });
  if (out === "conflict") {
    const cur = await deps.alerts.get(id);
    return sendJson(res, 409, { error: `cannot ${VERB[kind]} an alert in this state`, state: cur?.state });
  }
  let rulebook: RulebookEntry | undefined;
  if (contribute && resolution && deps.rulebook) {
    rulebook = { id: newId(deps), ruleId: out.ruleId, text: resolution, updatedBy: actor, updatedAt: at, alertId: id };
    await deps.rulebook.add(rulebook);
  }
  try {
    deps.publish?.({ type: "alert", alertId: id, kind: kind === "unacknowledged" ? "updated" : kind });
  } catch (e) {
    console.error("ui publish failed:", e);
  }
  // Not `rulebook`: on GET /api/alerts/{id} that name is the whole comment thread.
  sendJson(res, 200, rulebook ? { ...out, rulebookComment: rulebook } : out);
}

/** Returns false when the request is not an alerts/audit route. */
export async function handleAlertsRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  path: string,
  url: URL,
  deps: AlertsApiDeps,
): Promise<boolean> {
  const method = req.method ?? "GET";
  try {
    if (method === "GET" && path === "/api/alerts") return await listAlerts(res, url, deps), true;
    if (method === "GET" && path === "/api/alerts/summary") return await summaryRoute(res, url, deps), true;
    if (method === "GET" && path === "/api/audit") {
      const sp = url.searchParams;
      const beforeParam = sp.get("before");
      let before: AuditCursor | undefined;
      if (beforeParam) {
        before = decodeAuditCursor(beforeParam) ?? undefined;
        if (!before) return sendJson(res, 400, { error: "bad before" }), true;
      }
      const limit = parseLimit(sp.get("limit"), 50, 200);
      const rows = await deps.audit.list({
        alertId: sp.get("alertId") || undefined,
        actor: sp.get("actor") || undefined,
        action: sp.get("action") || undefined,
        before,
        limit,
      });
      const headers: Record<string, string> = {};
      if (rows.length === limit) headers["x-next-before"] = encodeAuditCursor(rows[rows.length - 1]!);
      sendJson(res, 200, rows, headers);
      return true;
    }
    const m = /^\/api\/alerts\/([^/]+)(?:\/(ack|unack|resolve|audit|suggestions|rulebook))?$/.exec(path);
    if (!m) return false;
    const sub = m[2];
    const allowed = sub === undefined || sub === "audit" ? "GET" : sub === "suggestions" || sub === "rulebook" || sub === "ack" || sub === "unack" || sub === "resolve" ? "POST" : "";
    if (method !== allowed) return false;
    const id = decodeSegment(m[1]!);
    if (id === null) return sendJson(res, 400, { error: "bad id" }), true;

    if (sub === undefined) {
      const alert = await deps.alerts.get(id);
      if (!alert) return sendJson(res, 404, { error: "alert not found" }), true;
      const ev = deps.events ? (await deps.events.getEvents([alert.eventId])).get(alert.eventId) : undefined;
      const suggestions = await deps.suggestions.listByAlert(id);
      const rulebook = deps.rulebook ? await deps.rulebook.list(alert.ruleId) : [];
      sendJson(res, 200, { ...alert, event: ev ?? null, suggestions, rulebook });
      return true;
    }
    if (sub === "audit") {
      if (!(await deps.alerts.get(id))) return sendJson(res, 404, { error: "alert not found" }), true;
      sendJson(res, 200, await deps.audit.listByAlert(id));
      return true;
    }
    if (sub === "ack" || sub === "unack" || sub === "resolve") {
      await transition(req, res, deps, id, sub === "ack" ? "acknowledged" : sub === "unack" ? "unacknowledged" : "resolved");
      return true;
    }
    if (sub === "rulebook") {
      const body = await readJsonBody(req);
      const alert = await deps.alerts.get(id);
      if (!alert) return sendJson(res, 404, { error: "alert not found" }), true;
      if (!deps.rulebook) return sendJson(res, 503, { error: "rulebook not configured" }), true;
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text || text.length > MAX_RESOLUTION_CHARS)
        return sendJson(res, 400, { error: `text must be 1 to ${MAX_RESOLUTION_CHARS} characters` }), true;
      const entry: RulebookEntry = {
        id: newId(deps),
        ruleId: alert.ruleId,
        text,
        updatedBy: resolveActor(req, body.actor),
        updatedAt: nowIso(deps),
        alertId: id,
      };
      await deps.rulebook.add(entry);
      return sendJson(res, 201, entry), true;
    }
    // suggestions
    const body = await readJsonBody(req);
    const alert = await deps.alerts.get(id);
    if (!alert) return sendJson(res, 404, { error: "alert not found" }), true;
    const s = await createSuggestion(req, res, deps, alert.ruleId, id, body, true);
    if (s) sendJson(res, 201, s);
    return true;
  } catch (e) {
    if (e instanceof BodyError) return sendBodyError(req, res, e), true;
    throw e;
  }
}
