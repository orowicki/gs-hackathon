-- Who changed what in the config: one row per successful write through the HTTP API.
-- actor is a person id; null when the request had no signed-in account.
CREATE TABLE IF NOT EXISTS config_changes (
  id bigserial PRIMARY KEY,
  kind text NOT NULL,
  item_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('create', 'update', 'delete', 'import')),
  actor text,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS config_changes_item ON config_changes (kind, item_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS config_changes_at ON config_changes (occurred_at DESC);
