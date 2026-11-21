-- Dedup atomicity (#137): the engine's open alert per (rule, dedup key) is kept in its own table, so
-- create-or-bump is one statement (no Redis lock) while other writers of `alerts` (API, fixtures,
-- seed) stay free to hold several open alerts with the same key.
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS severity_raised_by text;

CREATE TABLE IF NOT EXISTS alert_open_keys (
  rule_id   text NOT NULL,
  dedup_key text NOT NULL,
  alert_id  text NOT NULL,
  PRIMARY KEY (rule_id, dedup_key)
);

-- An earlier draft of this migration put a partial unique index on alerts; it must not stay.
DROP INDEX IF EXISTS alerts_open_dedup_uniq;

-- Keep counting into the alerts that are open now: map each key to its newest open alert.
INSERT INTO alert_open_keys (rule_id, dedup_key, alert_id)
SELECT DISTINCT ON (rule_id, dedup_key) rule_id, dedup_key, id
FROM alerts
WHERE state <> 'resolved'
ORDER BY rule_id, dedup_key, last_seen DESC, id DESC
ON CONFLICT (rule_id, dedup_key) DO NOTHING;
