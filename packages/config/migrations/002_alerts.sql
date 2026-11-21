CREATE TABLE IF NOT EXISTS alerts (
  id text PRIMARY KEY,
  rule_id text NOT NULL,
  dedup_key text NOT NULL,
  state text NOT NULL,
  last_seen timestamptz NOT NULL,
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS alerts_last_seen_idx ON alerts (last_seen DESC, id DESC);

CREATE TABLE IF NOT EXISTS alert_audit (
  id text PRIMARY KEY,
  alert_id text NOT NULL,
  at timestamptz NOT NULL,
  actor text NOT NULL,
  action text NOT NULL,
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS alert_audit_alert_idx ON alert_audit (alert_id, at);
CREATE INDEX IF NOT EXISTS alert_audit_at_idx ON alert_audit (at DESC);

CREATE TABLE IF NOT EXISTS suggestions (
  id text PRIMARY KEY,
  rule_id text NOT NULL,
  alert_id text,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS suggestions_rule_idx ON suggestions (rule_id);
CREATE INDEX IF NOT EXISTS suggestions_alert_idx ON suggestions (alert_id);
