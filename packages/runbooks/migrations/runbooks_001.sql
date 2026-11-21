-- Reference copy; the executed SQL is inlined in src/store-pg.ts (RUNBOOKS_SQL).
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
