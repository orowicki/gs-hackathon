CREATE TABLE IF NOT EXISTS events (
  id          text PRIMARY KEY,
  source_id   text NOT NULL,
  received_at timestamptz NOT NULL,
  raw         jsonb NOT NULL,
  parsed      jsonb NOT NULL,
  schema_id   text,
  common      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_received_at_idx ON events (received_at);
