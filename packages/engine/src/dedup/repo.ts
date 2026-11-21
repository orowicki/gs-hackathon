import type { Pool } from "pg";
import type { Alert } from "@alerting/shared";

/** Alert persistence used by dedup. Postgres is the authority for an alert's state. */
export interface AlertRepo {
  get(id: string): Promise<Alert | null>;
  upsert(alert: Alert): Promise<void>;
}

/** Postgres-backed repo on the `alerts` table (full Alert JSON in `data`, hot columns kept in sync). */
export function createPgAlertRepo(pool: Pick<Pool, "query">): AlertRepo {
  return {
    async get(id) {
      const r = await pool.query<{ data: Alert }>("SELECT data FROM alerts WHERE id = $1", [id]);
      return r.rows[0]?.data ?? null;
    },
    async upsert(alert) {
      await pool.query(
        `INSERT INTO alerts (id, rule_id, dedup_key, state, last_seen, data)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (id) DO UPDATE SET
           rule_id = EXCLUDED.rule_id, dedup_key = EXCLUDED.dedup_key, state = EXCLUDED.state,
           last_seen = EXCLUDED.last_seen, data = EXCLUDED.data`,
        [alert.id, alert.ruleId, alert.dedupKey, alert.state, alert.lastSeen, JSON.stringify(alert)],
      );
    },
  };
}

/** In-memory repo for tests. `alerts` is exposed so tests can inspect or change state ("the UI"). */
export function createMemoryAlertRepo(): AlertRepo & { alerts: Map<string, Alert> } {
  const alerts = new Map<string, Alert>();
  return {
    alerts,
    async get(id) {
      const a = alerts.get(id);
      return a ? structuredClone(a) : null;
    },
    async upsert(alert) {
      alerts.set(alert.id, structuredClone(alert));
    },
  };
}
