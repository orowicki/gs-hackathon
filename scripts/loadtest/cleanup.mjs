// Removes the data a load test leaves behind: Redis dedup/throttle keys and Postgres alerts/events tied to the
// temporary `lt-tmp-` ids. Redis streams (alerting:events:raw, alerting:events, alerting:alerts) are never touched;
// their entries stay (trimmed only by whatever MAXLEN the producers use).
import pg from "pg";

export const TMP_PREFIX = "lt-tmp-";

/** Redis key patterns (SCAN MATCH) holding state keyed by the temporary rule or person ids. */
export const REDIS_PATTERNS = [
  `alerting:dedup:${TMP_PREFIX}*`,
  `alerting:dedupseen:${TMP_PREFIX}*`,
  `alerting:deduplock:${TMP_PREFIX}*`,
  // delivery throttle counters / digest buffers are keyed by recipient (the temporary person)
  `alerting:throttle:${TMP_PREFIX}*`,
  `alerting:digest:${TMP_PREFIX}*`,
];

/** SCAN + UNLINK every key matching `pattern` in batches; returns the number of keys removed. */
export async function purgeRedisPattern(redis, pattern, batch = 1000) {
  let cursor = "0";
  let removed = 0;
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", pattern, "COUNT", batch);
    cursor = next;
    for (let i = 0; i < keys.length; i += batch) {
      removed += await redis.unlink(...keys.slice(i, i + batch));
    }
  } while (cursor !== "0");
  return removed;
}

export async function purgeRedis(redis, patterns = REDIS_PATTERNS) {
  const counts = {};
  for (const p of patterns) counts[p] = await purgeRedisPattern(redis, p);
  return counts;
}

/** Statements in FK-safe order; every one is restricted to rows tied to `lt-tmp-` rule/source ids. */
export const PG_STATEMENTS = [
  ["alert_audit", `DELETE FROM alert_audit WHERE alert_id IN (SELECT id FROM alerts WHERE rule_id LIKE $1)`],
  ["suggestions", `DELETE FROM suggestions WHERE rule_id LIKE $1 OR alert_id IN (SELECT id FROM alerts WHERE rule_id LIKE $1)`],
  ["alerts", `DELETE FROM alerts WHERE rule_id LIKE $1`],
  ["events", `DELETE FROM events WHERE source_id LIKE $1`],
];

export async function purgePostgres(databaseUrl) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const counts = {};
  try {
    for (const [name, sql] of PG_STATEMENTS) {
      const r = await pool.query(sql, [`${TMP_PREFIX}%`]);
      counts[name] = r.rowCount ?? 0;
    }
  } finally {
    await pool.end();
  }
  return counts;
}

/** Purge Redis keys and Postgres rows of load test runs; logs the counts. */
export async function purgeLoadtestData({ redis, databaseUrl, log = console.error }) {
  const keys = await purgeRedis(redis);
  const rows = await purgePostgres(databaseUrl);
  const total = Object.values(keys).reduce((a, b) => a + b, 0);
  log(
    `loadtest: purged ${total} redis keys (${Object.entries(keys).map(([k, v]) => `${k.split(":")[1]}=${v}`).join(" ")}), ` +
      `postgres rows (${Object.entries(rows).map(([k, v]) => `${k}=${v}`).join(" ")})`,
  );
  return { keys, rows };
}
