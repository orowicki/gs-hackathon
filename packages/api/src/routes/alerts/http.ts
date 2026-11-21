import type http from "node:http";
import type { Alert, AuditEntry, Event } from "@alerting/shared";
import { tryParse, validateTree, evaluate, type FilterNode } from "@alerting/filter";
import {
  BodyError,
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
import type { AlertCursor } from "./store.js";

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

function treeFields(n: FilterNode, out: Set<string> = new Set()): Set<string> {
  if (n.type === "and" || n.type === "or") n.children.forEach((c) => treeFields(c, out));
  else if (n.type === "not") treeFields(n.child, out);
  else out.add(n.field);
  return out;
}

async function listAlerts(res: http.ServerResponse, url: URL, deps: AlertsApiDeps): Promise<void> {
  const sp = url.searchParams;
  let tree: FilterNode | null = null;
  const filterText = sp.get("filter");
  const treeText = sp.get("tree");
  if (filterText !== null && filterText.trim() !== "") {
    const r = tryParse(filterText);
    if (!r.ok) return sendJson(res, 400, { error: r.error.message, position: r.error.position });
    tree = r.tree;
  } else if (treeText !== null) {
    let raw: unknown;
    try {
      raw = JSON.parse(treeText);
    } catch {
      return sendJson(res, 400, { error: "tree is not valid JSON" });
    }
    try {
      tree = validateTree(raw);
    } catch (e) {
      return sendJson(res, 400, { error: e instanceof Error ? e.message : "invalid tree" });
    }
  }
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

  if (!tree) {
    const rows = await deps.alerts.list({ state, before, limit });
    const headers: Record<string, string> = {};
    if (rows.length === limit) headers["x-next-before"] = encodeCursor(rows[rows.length - 1]!);
    return sendJson(res, 200, rows, headers);
  }

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

async function transition(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: AlertsApiDeps,
  id: string,
  kind: "acknowledged" | "resolved",
): Promise<void> {
  const body = await readJsonBody(req);
  const actor = resolveActor(req, body.actor);
  const at = nowIso(deps);
  const out =
    kind === "acknowledged"
      ? await deps.alerts.transition(id, ["open"], { state: "acknowledged", acknowledgedBy: actor, acknowledgedAt: at })
      : await deps.alerts.transition(id, ["open", "acknowledged"], { state: "resolved", resolvedAt: at });
  if (out === null) return sendJson(res, 404, { error: "alert not found" });
  if (out === "conflict") {
    const cur = await deps.alerts.get(id);
    return sendJson(res, 409, { error: `cannot ${kind === "acknowledged" ? "acknowledge" : "resolve"} an alert in this state`, state: cur?.state });
  }
  const entry: AuditEntry = { id: newId(deps), alertId: id, at, actor, action: kind };
  await deps.audit.append(entry);
  deps.publish?.({ type: "alert", alertId: id, kind });
  sendJson(res, 200, out);
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
    if (method === "GET" && path === "/api/audit") {
      const sp = url.searchParams;
      const beforeParam = sp.get("before");
      if (beforeParam !== null && Number.isNaN(Date.parse(beforeParam)))
        return sendJson(res, 400, { error: "bad before" }), true;
      sendJson(
        res,
        200,
        await deps.audit.list({
          alertId: sp.get("alertId") || undefined,
          actor: sp.get("actor") || undefined,
          action: sp.get("action") || undefined,
          before: beforeParam || undefined,
          limit: parseLimit(sp.get("limit"), 50, 200),
        }),
      );
      return true;
    }
    const m = /^\/api\/alerts\/([^/]+)(?:\/(ack|resolve|audit|suggestions))?$/.exec(path);
    if (!m) return false;
    const sub = m[2];
    const allowed = sub === undefined || sub === "audit" ? "GET" : sub === "suggestions" || sub === "ack" || sub === "resolve" ? "POST" : "";
    if (method !== allowed) return false;
    const id = decodeSegment(m[1]!);
    if (id === null) return sendJson(res, 400, { error: "bad id" }), true;

    if (sub === undefined) {
      const alert = await deps.alerts.get(id);
      if (!alert) return sendJson(res, 404, { error: "alert not found" }), true;
      const ev = deps.events ? (await deps.events.getEvents([alert.eventId])).get(alert.eventId) : undefined;
      const suggestions = await deps.suggestions.listByAlert(id);
      sendJson(res, 200, { ...alert, event: ev ?? null, suggestions });
      return true;
    }
    if (sub === "audit") {
      if (!(await deps.alerts.get(id))) return sendJson(res, 404, { error: "alert not found" }), true;
      sendJson(res, 200, await deps.audit.listByAlert(id));
      return true;
    }
    if (sub === "ack" || sub === "resolve") {
      await transition(req, res, deps, id, sub === "ack" ? "acknowledged" : "resolved");
      return true;
    }
    // suggestions
    const body = await readJsonBody(req);
    const alert = await deps.alerts.get(id);
    if (!alert) return sendJson(res, 404, { error: "alert not found" }), true;
    const s = await createSuggestion(req, res, deps, alert.ruleId, id, body);
    if (s) {
      await deps.audit.append({
        id: newId(deps),
        alertId: id,
        at: s.createdAt,
        actor: s.author,
        action: "suggestion",
        detail: s.text.slice(0, 200),
      });
      sendJson(res, 201, s);
    }
    return true;
  } catch (e) {
    if (e instanceof BodyError) return sendJson(res, e.status, { error: e.message }), true;
    throw e;
  }
}
