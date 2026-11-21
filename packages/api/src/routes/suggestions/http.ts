import type http from "node:http";
import type { Suggestion } from "@alerting/shared";
import {
  BodyError,
  decodeSegment,
  newId,
  nowIso,
  readJsonBody,
  resolveActor,
  sendJson,
  type AlertsApiDeps,
} from "../common.js";

export const MAX_SUGGESTION_CHARS = 4000;

/** Validate suggestion text: trimmed, 1..4000 chars. */
export function validText(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length >= 1 && t.length <= MAX_SUGGESTION_CHARS ? t : null;
}

export async function createSuggestion(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: AlertsApiDeps,
  ruleId: string,
  alertId: string | undefined,
  body: Record<string, unknown>,
): Promise<Suggestion | null> {
  const text = validText(body.text);
  if (text === null) {
    sendJson(res, 400, { error: `text is required (1..${MAX_SUGGESTION_CHARS} characters)` });
    return null;
  }
  const s: Suggestion = {
    id: newId(deps),
    ruleId,
    ...(alertId ? { alertId } : {}),
    author: resolveActor(req, body.author),
    text,
    status: "open",
    createdAt: nowIso(deps),
  };
  await deps.suggestions.create(s);
  return s;
}

/**
 * Suggestion routes. Rule existence is not checked here: rules live in the config store,
 * so a suggestion may reference any rule id.
 */
export async function handleSuggestionsRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  path: string,
  url: URL,
  deps: AlertsApiDeps,
): Promise<boolean> {
  const method = req.method ?? "GET";
  const rule = /^\/api\/rules\/([^/]+)\/suggestions$/.exec(path);
  if (rule && (method === "POST" || method === "GET")) {
    const ruleId = decodeSegment(rule[1]!);
    if (ruleId === null) return sendJson(res, 400, { error: "bad id" }), true;
    if (method === "GET") {
      const status = url.searchParams.get("status");
      if (status !== null && !["open", "accepted", "dismissed"].includes(status))
        return sendJson(res, 400, { error: "bad status" }), true;
      sendJson(res, 200, await deps.suggestions.listByRule(ruleId, (status as Suggestion["status"]) ?? undefined));
      return true;
    }
    try {
      const body = await readJsonBody(req);
      const alertId = typeof body.alertId === "string" && body.alertId !== "" ? body.alertId : undefined;
      const s = await createSuggestion(req, res, deps, ruleId, alertId, body);
      if (s) sendJson(res, 201, s);
    } catch (e) {
      if (e instanceof BodyError) sendJson(res, e.status, { error: e.message });
      else throw e;
    }
    return true;
  }
  const act = /^\/api\/suggestions\/([^/]+)\/(accept|dismiss)$/.exec(path);
  if (act && method === "POST") {
    const id = decodeSegment(act[1]!);
    if (id === null) return sendJson(res, 400, { error: "bad id" }), true;
    const out = await deps.suggestions.setStatus(id, "open", act[2] === "accept" ? "accepted" : "dismissed");
    if (out === null) sendJson(res, 404, { error: "suggestion not found" });
    else if (out === "conflict") {
      const cur = await deps.suggestions.get(id);
      sendJson(res, 409, { error: "suggestion is not open", status: cur?.status });
    } else sendJson(res, 200, out);
    return true;
  }
  return false;
}
