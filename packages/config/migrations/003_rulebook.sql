CREATE TABLE IF NOT EXISTS rulebook (
  rule_id text PRIMARY KEY,
  updated_at timestamptz NOT NULL,
  data jsonb NOT NULL
);
