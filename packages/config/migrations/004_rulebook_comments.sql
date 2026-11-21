-- "How to resolve" becomes a comment thread per rule instead of one replaceable text.
CREATE TABLE IF NOT EXISTS rulebook_comments (
  id text PRIMARY KEY,
  rule_id text NOT NULL,
  at timestamptz NOT NULL,
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS rulebook_comments_rule_at ON rulebook_comments (rule_id, at, id);

-- Keep texts written before this change as the first comment of their rule.
INSERT INTO rulebook_comments (id, rule_id, at, data)
SELECT 'rb-' || rule_id, rule_id, updated_at, data || jsonb_build_object('id', 'rb-' || rule_id)
FROM rulebook
ON CONFLICT (id) DO NOTHING;
