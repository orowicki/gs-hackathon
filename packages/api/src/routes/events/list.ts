import type http from "node:http";
import type { Event } from "@alerting/shared";
import {
  evaluate,
  tryParse,
  validateTree,
  type FilterNode,
} from "@alerting/filter";
import { parseLimit, sendJson } from "../common.js";
import { eventContext } from "./http.js";

export interface EventCursor {
  receivedAt: string;
  id: string;
}

export interface EventList {
  /** Newest first (receivedAt desc, id desc); strictly older than `before` when given. */
  list(q: { before?: EventCursor; limit: number }): Promise<Event[]>;
}

const BATCH = 200;
const SCAN_CAP = 5000;

export function encodeEventCursor(e: EventCursor): string {
  return Buffer.from(
    JSON.stringify({ receivedAt: e.receivedAt, id: e.id }),
  ).toString("base64url");
}

export function decodeEventCursor(s: string): EventCursor | null {
  try {
    const v = JSON.parse(
      Buffer.from(s, "base64url").toString("utf8"),
    ) as Partial<EventCursor>;
    if (
      typeof v.receivedAt === "string" &&
      typeof v.id === "string" &&
      !Number.isNaN(Date.parse(v.receivedAt))
    )
      return { receivedAt: v.receivedAt, id: v.id };
  } catch {
    /* fall through */
  }
  return null;
}

type TreeResult =
  { tree: FilterNode | null } | { body: Record<string, unknown> };

function parseTree(sp: URLSearchParams): TreeResult {
  const filterText = sp.get("filter");
  const treeText = sp.get("tree");
  if (filterText !== null && filterText.trim() !== "") {
    const r = tryParse(filterText);
    if (!r.ok)
      return { body: { error: r.error.message, position: r.error.position } };
    return { tree: r.tree };
  }
  if (treeText !== null) {
    let raw: unknown;
    try {
      raw = JSON.parse(treeText);
    } catch {
      return { body: { error: "tree is not valid JSON" } };
    }
    try {
      return { tree: validateTree(raw) };
    } catch (e) {
      return {
        body: { error: e instanceof Error ? e.message : "invalid tree" },
      };
    }
  }
  return { tree: null };
}

export async function listEvents(
  res: http.ServerResponse,
  url: URL,
  store: EventList,
): Promise<void> {
  const sp = url.searchParams;
  const t = parseTree(sp);
  if ("body" in t) return sendJson(res, 400, t.body);
  const tree = t.tree;
  const limit = parseLimit(sp.get("limit"), 50, 200);
  let before: EventCursor | undefined;
  const beforeParam = sp.get("before");
  if (beforeParam) {
    before = decodeEventCursor(beforeParam) ?? undefined;
    if (!before) return sendJson(res, 400, { error: "bad before cursor" });
  }

  if (!tree) {
    const rows = await store.list({ before, limit });
    const headers: Record<string, string> = {};
    if (rows.length === limit)
      headers["x-next-before"] = encodeEventCursor(rows[rows.length - 1]!);
    return sendJson(res, 200, rows, headers);
  }

  const out: Event[] = [];
  let scanned = 0;
  let cursor = before;
  let last: Event | undefined;
  let exhausted = false;
  scan: while (scanned < SCAN_CAP) {
    const batch = await store.list({ before: cursor, limit: BATCH });
    if (batch.length === 0) {
      exhausted = true;
      break;
    }
    for (const e of batch) {
      scanned++;
      last = e;
      if (evaluate(tree, eventContext(e))) {
        out.push(e);
        if (out.length >= limit) break scan;
      }
      if (scanned >= SCAN_CAP) break scan;
    }
    if (batch.length < BATCH) {
      exhausted = true;
      break;
    }
    cursor = {
      receivedAt: batch[batch.length - 1]!.receivedAt,
      id: batch[batch.length - 1]!.id,
    };
  }
  const headers: Record<string, string> = {};
  if (!exhausted && last) headers["x-next-before"] = encodeEventCursor(last);
  sendJson(res, 200, out, headers);
}

interface Pool {
  query<R>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
}

/** Reads ingest's `events` table; an absent table yields no events. */
export function createPgEventList(pool: Pool): EventList {
  interface Row {
    id: string;
    source_id: string;
    received_at: Date | string;
    raw: unknown;
    parsed: unknown;
    schema_id: string | null;
    common: unknown;
  }
  // Ingest writes received_at from JS ISO strings (millisecond precision), so the raw column
  // matches the ISO cursor and the received_at index stays usable.
  const ts = "received_at";
  return {
    async list({ before, limit }) {
      const where = before ? `WHERE (${ts}, id) < ($2::timestamptz, $3)` : "";
      const params: unknown[] = [limit];
      if (before) params.push(before.receivedAt, before.id);
      try {
        const { rows } = await pool.query<Row>(
          `SELECT id, source_id, received_at, raw, parsed, schema_id, common FROM events ${where} ORDER BY ${ts} DESC, id DESC LIMIT $1`,
          params,
        );
        return rows.map((r) => ({
          id: r.id,
          sourceId: r.source_id,
          receivedAt: new Date(r.received_at).toISOString(),
          raw: r.raw as Event["raw"],
          parsed: r.parsed as Event["parsed"],
          schemaId: r.schema_id,
          common: (r.common ?? {}) as Event["common"],
        }));
      } catch (e) {
        if ((e as { code?: string }).code === "42P01") return [];
        throw e;
      }
    },
  };
}

/** In-memory list over a fixed set of events (tests, dev). */
export function createMemoryEventList(events: Event[]): EventList {
  const sorted = [...events].sort((a, b) =>
    a.receivedAt === b.receivedAt
      ? a.id < b.id
        ? 1
        : -1
      : a.receivedAt < b.receivedAt
        ? 1
        : -1,
  );
  return {
    async list({ before, limit }) {
      const rows = before
        ? sorted.filter(
            (e) =>
              e.receivedAt < before.receivedAt ||
              (e.receivedAt === before.receivedAt && e.id < before.id),
          )
        : sorted;
      return rows.slice(0, limit);
    },
  };
}
