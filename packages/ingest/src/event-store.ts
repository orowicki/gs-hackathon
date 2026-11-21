import type { Pool } from "pg";
import type { Event } from "@alerting/shared";

/** Insert events in one statement. Idempotent on `id` (conflicts are ignored). Returns rows inserted. */
export async function insertEvents(pool: Pick<Pool, "query">, events: Event[]): Promise<number> {
  if (events.length === 0) return 0;
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
