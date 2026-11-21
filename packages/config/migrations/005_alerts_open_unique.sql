-- Dedup atomicity (#137): at most one unresolved alert per (rule, dedup key), so the engine can
-- create-or-bump with a single INSERT ... ON CONFLICT instead of a Redis lock.
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS severity_raised_by text;

-- Duplicates from before this index would make it fail: keep the newest open alert of each key and
-- resolve the older ones.
UPDATE alerts a SET state = 'resolved',
  data = a.data || jsonb_build_object('state', 'resolved', 'resolvedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
WHERE a.state <> 'resolved'
  AND EXISTS (
    SELECT 1 FROM alerts b
    WHERE b.rule_id = a.rule_id AND b.dedup_key = a.dedup_key AND b.state <> 'resolved'
      AND (b.last_seen, b.id) > (a.last_seen, a.id)
  );

CREATE UNIQUE INDEX IF NOT EXISTS alerts_open_dedup_uniq ON alerts (rule_id, dedup_key) WHERE state <> 'resolved';
