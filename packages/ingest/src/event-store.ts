import type { Pool } from "pg";
import type { Event } from "@alerting/shared";

/** Recursively remove NUL characters from strings (Postgres jsonb/text rejects them), including object keys. */
export function stripNul<T>(v: T): T {
  if (typeof v === "string")
    return (v.includes("\u0000") ? v.replaceAll("\u0000", "") : v) as T;
  if (Array.isArray(v)) return v.map((x) => stripNul(x)) as T;
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[stripNul(k)] = stripNul(x);
    return out as T;
  }
  return v;
}

/** True when a pg error is a data/constraint error (class 22 or 23): retrying the same row cannot succeed. */
export function isDataError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return (
    typeof code === "string" && (code.startsWith("22") || code.startsWith("23"))
  );
}

/** Insert events in one statement. Idempotent on `id` (conflicts are ignored). Returns rows inserted. */
export async function insertEvents(
  pool: Pick<Pool, "query">,
  events: Event[],
): Promise<number> {
  if (events.length === 0) return 0;
  events = events.map((e) => ({
    ...e,
    sourceId: stripNul(e.sourceId),
    raw: stripNul(e.raw),
    parsed: stripNul(e.parsed),
    common: stripNul(e.common),
  }));
  const res = await pool.query(
    `INSERT INTO events (id, source_id, received_at, raw, parsed, schema_id, common)
     SELECT id, source_id, received_at::timestamptz, raw::jsonb, parsed::jsonb, schema_id, common::jsonb
     FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[])
       AS t(id, source_id, received_at, raw, parsed, schema_id, common)
     ON CONFLICT (id) DO NOTHING`,
    [
      events.map((e) => e.id),
      events.map((e) => e.sourceId),
      events.map((e) => e.receivedAt),
      events.map((e) => JSON.stringify(e.raw)),
      events.map((e) => JSON.stringify(e.parsed)),
      events.map((e) => e.schemaId),
      events.map((e) => JSON.stringify(e.common)),
    ],
  );
  return res.rowCount ?? 0;
}
