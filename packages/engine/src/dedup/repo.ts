import type { Pool } from "pg";
import { SEVERITIES, compareSeverity, type Alert, type IsoTimestamp, type Severity } from "@alerting/shared";

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
  bump(id: string, input: BumpInput): Promise<{ alert: Alert; previousSeverity: Severity } | null>;
  /** Atomically mark resolved. Null when the alert is missing or already resolved. */
  resolve(id: string, at: IsoTimestamp, common: Alert["common"]): Promise<Alert | null>;
}

/** Postgres-backed repo on the `alerts` table (full Alert JSON in `data`, hot columns kept in sync). */
export function createPgAlertRepo(pool: Pick<Pool, "query">): AlertRepo {
  return {
    async get(id) {
      const r = await pool.query<{ data: Alert }>("SELECT data FROM alerts WHERE id = $1", [id]);
      return r.rows[0]?.data ?? null;
    },
    async create(alert) {
      const ins = await pool.query<{ data: Alert }>(
        `INSERT INTO alerts (id, rule_id, dedup_key, state, last_seen, data)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (id) DO NOTHING RETURNING data`,
        [alert.id, alert.ruleId, alert.dedupKey, alert.state, alert.lastSeen, JSON.stringify(alert)],
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
        [id, input.lastSeen, input.lastSeen, JSON.stringify(input.common), [...SEVERITIES], input.severity],
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
export function createMemoryAlertRepo(): AlertRepo & { alerts: Map<string, Alert> } {
  const alerts = new Map<string, Alert>();
  return {
    alerts,
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
      if (compareSeverity(input.severity, a.severity) > 0) a.severity = input.severity;
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
