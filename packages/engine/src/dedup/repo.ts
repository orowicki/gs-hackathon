import type { Pool } from "pg";
import {
  SEVERITIES,
  compareSeverity,
  type Alert,
  type IsoTimestamp,
  type Severity,
} from "@alerting/shared";

export interface BumpInput {
  lastSeen: IsoTimestamp;
  /** Severity of the new event; the stored severity only ever goes up. */
  severity: Severity;
  common: Alert["common"];
}

/**
 * Alert persistence used by dedup. Postgres is the authority for an alert's state: the API acks and
 * resolves alerts without taking the engine's lock, so the engine only ever applies atomic partial
 * updates and never rewrites `state` of an unresolved alert from a stale copy.
 */
export interface AlertRepo {
  get(id: string): Promise<Alert | null>;
  /** Insert; if the id already exists nothing is changed. Returns the stored alert and whether this call created it. */
  create(alert: Alert): Promise<{ alert: Alert; created: boolean }>;
  /** Atomically count+1, lastSeen, raise severity. Null when the alert is missing or resolved. */
  bump(
    id: string,
    input: BumpInput,
  ): Promise<{ alert: Alert; previousSeverity: Severity } | null>;
  /** Atomically mark resolved. Null when the alert is missing or already resolved. */
  resolve(
    id: string,
    at: IsoTimestamp,
    common: Alert["common"],
  ): Promise<Alert | null>;
  /**
   * One atomic step: create `alert`, or, if an unresolved alert with the same (ruleId, dedupKey)
   * exists, bump that one (count+1, lastSeen, severity raise). `raised` is true when this call raised
   * the severity. Null when `alert.id` already exists (the event was applied before: replay path).
   */
  upsertOpen(
    alert: Alert,
  ): Promise<{ alert: Alert; created: boolean; raised: boolean } | null>;
  /** Atomically resolve the unresolved alert of (ruleId, dedupKey). Null when there is none. */
  resolveOpen(
    ruleId: string,
    dedupKey: string,
    at: IsoTimestamp,
    common: Alert["common"],
  ): Promise<Alert | null>;
}

const ENSURE_SQL = [
  "ALTER TABLE alerts ADD COLUMN IF NOT EXISTS severity_raised_by text",
  "CREATE UNIQUE INDEX IF NOT EXISTS alerts_open_dedup_uniq ON alerts (rule_id, dedup_key) WHERE state <> 'resolved'",
];

/** Postgres-backed repo on the `alerts` table (full Alert JSON in `data`, hot columns kept in sync). */
export function createPgAlertRepo(pool: Pick<Pool, "query">): AlertRepo {
  // Normally migration 005 has run; this only covers databases created from the bare table DDL.
  let ready: Promise<void> | undefined;
  const ensure = () =>
    (ready ??= (async () => {
      const present = async () =>
        (
          await pool.query(
            `SELECT (SELECT count(*) FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'alerts' AND indexname = 'alerts_open_dedup_uniq')
                  + (SELECT count(*) FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'alerts' AND column_name = 'severity_raised_by') AS n`,
          )
        ).rows[0]?.n == 2;
      if (await present()) return;
      try {
        for (const q of ENSURE_SQL) await pool.query(q);
      } catch (err) {
        if (!(await present())) throw err; // lost a race with another process doing the same
      }
    })().catch((err) => {
      // memoized on purpose: fail fast on every call instead of re-running DDL per event
      console.error(
        `dedup: alerts schema (migration 005) missing and could not be applied: ${(err as Error).message}`,
      );
      throw err;
    }));
  return {
    async upsertOpen(alert) {
      await ensure();
      const r = await pool.query<{
        data: Alert;
        created: boolean;
        raised: boolean;
      }>(
        `INSERT INTO alerts (id, rule_id, dedup_key, state, last_seen, data)
         SELECT $1::text, $2::text, $3::text, $4::text, $5::timestamptz, $6::jsonb
         WHERE NOT EXISTS (SELECT 1 FROM alerts WHERE id = $1::text)
         ON CONFLICT (rule_id, dedup_key) WHERE state <> 'resolved' DO UPDATE SET
           last_seen = GREATEST(alerts.last_seen, EXCLUDED.last_seen),
           severity_raised_by = CASE
             WHEN COALESCE(array_position($7::text[], EXCLUDED.data->>'severity'), 0) > COALESCE(array_position($7::text[], alerts.data->>'severity'), 0)
             THEN EXCLUDED.id ELSE alerts.severity_raised_by END,
           data = alerts.data || jsonb_build_object(
             'count', COALESCE((alerts.data->>'count')::int, 0) + 1,
             'lastSeen', CASE WHEN EXCLUDED.last_seen >= alerts.last_seen THEN EXCLUDED.data->>'lastSeen' ELSE alerts.data->>'lastSeen' END,
             'common', CASE WHEN EXCLUDED.last_seen >= alerts.last_seen THEN EXCLUDED.data->'common' ELSE alerts.data->'common' END,
             'severity', CASE
               WHEN COALESCE(array_position($7::text[], EXCLUDED.data->>'severity'), 0) > COALESCE(array_position($7::text[], alerts.data->>'severity'), 0)
               THEN EXCLUDED.data->>'severity' ELSE alerts.data->>'severity' END)
         RETURNING data, (xmax = 0) AS created, (severity_raised_by IS NOT DISTINCT FROM $1::text AND xmax <> 0) AS raised`,
        [
          alert.id,
          alert.ruleId,
          alert.dedupKey,
          alert.state,
          alert.lastSeen,
          JSON.stringify(alert),
          [...SEVERITIES],
        ],
      );
      const row = r.rows[0];
      return row
        ? { alert: row.data, created: row.created, raised: row.raised }
        : null;
    },
    async resolveOpen(ruleId, dedupKey, at, common) {
      const r = await pool.query<{ data: Alert }>(
        `UPDATE alerts SET state = 'resolved', last_seen = $3::timestamptz,
           data = data || jsonb_build_object('state', 'resolved', 'resolvedAt', $4::text, 'lastSeen', $4::text, 'common', $5::jsonb)
         WHERE rule_id = $1 AND dedup_key = $2 AND state <> 'resolved' RETURNING data`,
        [ruleId, dedupKey, at, at, JSON.stringify(common)],
      );
      return r.rows[0]?.data ?? null;
    },
    async get(id) {
      const r = await pool.query<{ data: Alert }>(
        "SELECT data FROM alerts WHERE id = $1",
        [id],
      );
      return r.rows[0]?.data ?? null;
    },
    async create(alert) {
      const ins = await pool.query<{ data: Alert }>(
        `INSERT INTO alerts (id, rule_id, dedup_key, state, last_seen, data)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (id) DO NOTHING RETURNING data`,
        [
          alert.id,
          alert.ruleId,
          alert.dedupKey,
          alert.state,
          alert.lastSeen,
          JSON.stringify(alert),
        ],
      );
      if (ins.rows[0]) return { alert: ins.rows[0].data, created: true };
      const existing = await this.get(alert.id);
      return { alert: existing ?? alert, created: false };
    },
    async bump(id, input) {
      const r = await pool.query<{ data: Alert; old_sev: Severity }>(
        `WITH old AS (
           SELECT id, data->>'severity' AS sev FROM alerts WHERE id = $1 AND state <> 'resolved' FOR UPDATE
         )
         UPDATE alerts a SET
           last_seen = $2::timestamptz,
           data = a.data || jsonb_build_object(
             'count', COALESCE((a.data->>'count')::int, 0) + 1,
             'lastSeen', $3::text,
             'common', $4::jsonb,
             'severity', CASE WHEN COALESCE(array_position($5::text[], $6::text), 0) > COALESCE(array_position($5::text[], old.sev), 0)
                              THEN $6::text ELSE old.sev END)
         FROM old WHERE a.id = old.id
         RETURNING a.data, old.sev AS old_sev`,
        [
          id,
          input.lastSeen,
          input.lastSeen,
          JSON.stringify(input.common),
          [...SEVERITIES],
          input.severity,
        ],
      );
      const row = r.rows[0];
      return row ? { alert: row.data, previousSeverity: row.old_sev } : null;
    },
    async resolve(id, at, common) {
      const r = await pool.query<{ data: Alert }>(
        `UPDATE alerts SET state = 'resolved', last_seen = $2::timestamptz,
           data = data || jsonb_build_object('state', 'resolved', 'resolvedAt', $3::text, 'lastSeen', $3::text, 'common', $4::jsonb)
         WHERE id = $1 AND state <> 'resolved' RETURNING data`,
        [id, at, at, JSON.stringify(common)],
      );
      return r.rows[0]?.data ?? null;
    },
  };
}

/** In-memory repo for tests, same semantics as the Postgres one. `alerts` is exposed so tests can act as "the UI". */
export function createMemoryAlertRepo(): AlertRepo & {
  alerts: Map<string, Alert>;
} {
  const alerts = new Map<string, Alert>();
  const findOpen = (ruleId: string, dedupKey: string) => {
    for (const a of alerts.values())
      if (
        a.ruleId === ruleId &&
        a.dedupKey === dedupKey &&
        a.state !== "resolved"
      )
        return a;
    return undefined;
  };
  return {
    alerts,
    async upsertOpen(alert) {
      if (alerts.has(alert.id)) return null;
      const open = findOpen(alert.ruleId, alert.dedupKey);
      if (!open) {
        alerts.set(alert.id, structuredClone(alert));
        return { alert: structuredClone(alert), created: true, raised: false };
      }
      const raised = compareSeverity(alert.severity, open.severity) > 0;
      open.count += 1;
      if (Date.parse(alert.lastSeen) >= Date.parse(open.lastSeen)) {
        open.lastSeen = alert.lastSeen;
        open.common = structuredClone(alert.common);
      }
      if (raised) open.severity = alert.severity;
      return { alert: structuredClone(open), created: false, raised };
    },
    async resolveOpen(ruleId, dedupKey, at, common) {
      const a = findOpen(ruleId, dedupKey);
      if (!a) return null;
      a.state = "resolved";
      a.resolvedAt = at;
      a.lastSeen = at;
      a.common = structuredClone(common);
      return structuredClone(a);
    },
    async get(id) {
      const a = alerts.get(id);
      return a ? structuredClone(a) : null;
    },
    async create(alert) {
      const existing = alerts.get(alert.id);
      if (existing) return { alert: structuredClone(existing), created: false };
      alerts.set(alert.id, structuredClone(alert));
      return { alert: structuredClone(alert), created: true };
    },
    async bump(id, input) {
      const a = alerts.get(id);
      if (!a || a.state === "resolved") return null;
      const previousSeverity = a.severity;
      a.count += 1;
      a.lastSeen = input.lastSeen;
      a.common = structuredClone(input.common);
      if (compareSeverity(input.severity, a.severity) > 0)
        a.severity = input.severity;
      return { alert: structuredClone(a), previousSeverity };
    },
    async resolve(id, at, common) {
      const a = alerts.get(id);
      if (!a || a.state === "resolved") return null;
      a.state = "resolved";
      a.resolvedAt = at;
      a.lastSeen = at;
      a.common = structuredClone(common);
      return structuredClone(a);
    },
  };
}
