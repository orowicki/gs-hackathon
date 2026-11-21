import type { Pool } from "pg";
import type { AuditEntry, PendingApproval } from "@alerting/shared";
import { pendingOf, tail, type RunStore, type StoredRun } from "./store.js";

const RUNBOOKS_SQL = `
CREATE TABLE IF NOT EXISTS runbook_runs (
  alert_id text NOT NULL,
  runbook_id text NOT NULL,
  data jsonb NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (alert_id, runbook_id)
);
CREATE INDEX IF NOT EXISTS runbook_runs_status_idx ON runbook_runs (status);
CREATE TABLE IF NOT EXISTS audit_log (
  seq bigserial,
  id text PRIMARY KEY,
  alert_id text NOT NULL,
  at timestamptz NOT NULL,
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_log_alert_idx ON audit_log (alert_id, seq);
`;

/** Idempotent. Same DDL as migrations/runbooks_001.sql (inlined so compiled code needs no file lookup). */
export async function migrateRunbooks(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(704150002)");
    try {
      await client.query(RUNBOOKS_SQL);
    } finally {
      await client.query("SELECT pg_advisory_unlock(704150002)");
    }
  } finally {
    client.release();
  }
}

export function createPgRunStore(pool: Pool): RunStore {
  const rows = (r: { rows: Array<{ data: StoredRun }> }) => r.rows.map((x) => x.data);
  return {
    async createRun(run) {
      const r = await pool.query(
        "INSERT INTO runbook_runs (alert_id, runbook_id, data, status, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
        [run.alertId, run.runbookId, JSON.stringify(run), run.status, run.createdAt, run.updatedAt],
      );
      return r.rowCount === 1;
    },
    async getRun(a, rb) {
      return rows(await pool.query("SELECT data FROM runbook_runs WHERE alert_id=$1 AND runbook_id=$2", [a, rb]))[0];
    },
    async listRuns(a) {
      return rows(await pool.query("SELECT data FROM runbook_runs WHERE alert_id=$1 ORDER BY created_at, runbook_id", [a]));
    },
    async updateRun(run) {
      const next = { ...run, version: run.version + 1 };
      const r = await pool.query(
        "UPDATE runbook_runs SET data=$3, status=$4, updated_at=$5 WHERE alert_id=$1 AND runbook_id=$2 AND (data->>'version')::int = $6",
        [run.alertId, run.runbookId, JSON.stringify(next), run.status, run.updatedAt, run.version],
      );
      return r.rowCount === 1;
    },
    async appendAudit(e: AuditEntry) {
      await pool.query("INSERT INTO audit_log (id, alert_id, at, data) VALUES ($1,$2,$3,$4)", [
        e.id,
        e.alertId,
        e.at,
        JSON.stringify(e),
      ]);
    },
    async listAudit({ alertId, limit } = {}) {
      // newest `limit` rows, then returned oldest-first
      const params: unknown[] = [];
      let sql = "SELECT data FROM audit_log";
      if (alertId !== undefined) {
        params.push(alertId);
        sql += " WHERE alert_id=$1";
      }
      sql += " ORDER BY seq DESC";
      if (limit !== undefined) {
        params.push(limit);
        sql += ` LIMIT $${params.length}`;
      }
      const r = await pool.query<{ data: AuditEntry }>(sql, params);
      return tail(r.rows.map((x) => x.data).reverse(), limit);
    },
    async listPendingApprovals(): Promise<PendingApproval[]> {
      return rows(await pool.query("SELECT data FROM runbook_runs WHERE status='awaiting_approval'")).flatMap(pendingOf);
    },
  };
}
