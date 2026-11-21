import type http from "node:http";
import { LIST_RECENT_EVENTS, type Event } from "@alerting/shared";
import { tryParse, validateTree, evaluate, type EvalContext, type FilterNode } from "@alerting/filter";
import { BodyError, parseLimit, readJsonBody, sendJson } from "../common.js";

export interface EventsApiDeps {
  /** Newest first. */
  recentEvents(limit: number): Promise<Event[]>;
}

/** Filter context for an event: `alert.status` is not available on events. */
export function eventContext(e: Event): EvalContext {
  return {
    alert: { ...e.common, schema: e.schemaId, sourceStatus: e.common?.status },
    event: e.parsed ?? e.raw,
  } as EvalContext;
}

export async function handleEventsRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  path: string,
  url: URL,
  deps: Partial<EventsApiDeps>,
): Promise<boolean> {
  if (!deps.recentEvents) return false;
  if (req.method === "GET" && path === "/api/events/recent") {
    const limit = parseLimit(url.searchParams.get("limit"), 50, 1000);
    sendJson(res, 200, await deps.recentEvents(limit));
    return true;
  }
  if (req.method === "POST" && path === "/api/events/test-filter") {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      if (e instanceof BodyError) {
        sendJson(res, e.status, { error: e.message });
        return true;
      }
      throw e;
    }
    let tree: FilterNode | null = null;
    const f = body.filter;
    if (typeof f === "string") {
      if (f.trim() !== "") {
        const r = tryParse(f);
        if (!r.ok) {
          sendJson(res, 400, { error: r.error.message, position: r.error.position });
          return true;
        }
        tree = r.tree;
      }
    } else if (f !== null && f !== undefined) {
      try {
        tree = validateTree(f);
      } catch (e) {
        sendJson(res, 400, { error: e instanceof Error ? e.message : "invalid tree" });
        return true;
      }
    }
    const lim = typeof body.limit === "number" ? String(body.limit) : url.searchParams.get("limit");
    const events = await deps.recentEvents(parseLimit(lim, 1000, 1000));
    let matched = 0;
    for (const e of events) {
      if (!tree || evaluate(tree, eventContext(e))) matched++;
    }
    sendJson(res, 200, { matched, total: events.length });
    return true;
  }
  return false;
}

export function createRedisRecentEvents(redis: {
  lrange(key: string, start: number, stop: number): Promise<string[]>;
}): EventsApiDeps["recentEvents"] {
  return async (limit) => {
    const items = await redis.lrange(LIST_RECENT_EVENTS, 0, limit - 1);
    const out: Event[] = [];
    for (const s of items) {
      try {
        const v: unknown = JSON.parse(s);
        if (typeof v === "object" && v !== null && !Array.isArray(v)) out.push(v as Event);
      } catch {
        /* skip bad entry */
      }
    }
    return out;
  };
}
