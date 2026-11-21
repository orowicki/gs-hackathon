import type { Pool } from "pg";
import {
  SEVERITIES,
  compareSeverity,
  type Alert,
  type IsoTimestamp,
  type Severity,
} from "@alerting/shared";

export interface BumpInput {
  lastSeen: IsoTimestamp;
  /** Severity of the new event; the stored severity only ever goes up. */
  severity: Severity;
  common: Alert["common"];
}

/**
 * Alert persistence used by dedup. Postgres is the authority for an alert's state: the API acks and
 * resolves alerts without taking the engine's lock, so the engine only ever applies atomic partial
 * updates and never rewrites `state` of an unresolved alert from a stale copy.
 */
export interface AlertRepo {
  get(id: string): Promise<Alert | null>;
  /** Insert; if the id already exists nothing is changed. Returns the stored alert and whether this call created it. */
  create(alert: Alert): Promise<{ alert: Alert; created: boolean }>;
  /** Atomically count+1, lastSeen, raise severity. Null when the alert is missing or resolved. */
  bump(
    id: string,
    input: BumpInput,
  ): Promise<{ alert: Alert; previousSeverity: Severity } | null>;
  /** Atomically mark resolved. Null when the alert is missing or already resolved. */
  resolve(
    id: string,
    at: IsoTimestamp,
    common: Alert["common"],
  ): Promise<Alert | null>;
  /**
   * One atomic step: create `alert`, or, if an unresolved alert with the same (ruleId, dedupKey)
   * exists, bump that one (count+1, lastSeen, severity raise). `raised` is true when this call raised
   * the severity. Null when `alert.id` already exists (the event was applied before: replay path).
   */
  upsertOpen(
    alert: Alert,
  ): Promise<{ alert: Alert; created: boolean; raised: boolean } | null>;
  /** Atomically resolve the unresolved alert of (ruleId, dedupKey). Null when there is none. */
  resolveOpen(
    ruleId: string,
    dedupKey: string,
    at: IsoTimestamp,
    common: Alert["common"],
  ): Promise<Alert | null>;
}

const ENSURE_SQL = [
  "ALTER TABLE alerts ADD COLUMN IF NOT EXISTS severity_raised_by text",
  "CREATE UNIQUE INDEX IF NOT EXISTS alerts_open_dedup_uniq ON alerts (rule_id, dedup_key) WHERE state <> 'resolved'",
];

/** SQLSTATE class 22 (data exception) or 23 (integrity constraint violation). */
const isDataError = (err: unknown): boolean => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && (code.startsWith("22") || code.startsWith("23"));
};

type UpsertResult = { alert: Alert; created: boolean; raised: boolean };

const batchKey = (ruleId: string, dedupKey: string) => `${ruleId}\u0000${dedupKey}`;

// Shared by the single and the batched upsert; $7 is the severity order. `EXCLUDED` is the row
// proposed for insertion, so in the batched form every row is compared with its own input.
const ON_CONFLICT_BUMP = `ON CONFLICT (rule_id, dedup_key) WHERE state <> 'resolved' DO UPDATE SET
         last_seen = GREATEST(alerts.last_seen, EXCLUDED.last_seen),
         severity_raised_by = CASE
           WHEN COALESCE(array_position($7::text[], EXCLUDED.data->>'severity'), 0) > COALESCE(array_position($7::text[], alerts.data->>'severity'), 0)
           THEN EXCLUDED.id ELSE alerts.severity_raised_by END,
         data = alerts.data || jsonb_build_object(
           'count', COALESCE((alerts.data->>'count')::int, 0) + 1,
           'lastSeen', CASE WHEN EXCLUDED.last_seen >= alerts.last_seen THEN EXCLUDED.data->>'lastSeen' ELSE alerts.data->>'lastSeen' END,
           'common', CASE WHEN EXCLUDED.last_seen >= alerts.last_seen THEN EXCLUDED.data->'common' ELSE alerts.data->'common' END,
           'severity', CASE
             WHEN COALESCE(array_position($7::text[], EXCLUDED.data->>'severity'), 0) > COALESCE(array_position($7::text[], alerts.data->>'severity'), 0)
             THEN EXCLUDED.data->>'severity' ELSE alerts.data->>'severity' END)`;

/** Postgres-backed repo on the `alerts` table (full Alert JSON in `data`, hot columns kept in sync). */
export function createPgAlertRepo(
  pool: Pick<Pool, "query">,
  opts: {
    retryMs?: number;
    logger?: { error(msg: string): void };
    /** Max upserts per statement (default 500). */
    maxBatch?: number;
    /** Max upsert statements running at once (default 4; keep below the pool size). */
    maxInFlight?: number;
    /**
     * An upsert not yet sent this long after the call is rejected instead (default 30000). With the
     * pool's statement_timeout (10 s in the engine) this bounds one upsertOpen to ~40 s, below the
     * dedup claim lifetime (PENDING_MS, 60 s), so a claim never expires while its upsert can still run.
     */
    maxWaitMs?: number;
  } = {},
): AlertRepo {
  const retryMs = opts.retryMs ?? 5000;
  const maxBatch = Math.max(1, opts.maxBatch ?? 500);
  const maxInFlight = Math.max(1, opts.maxInFlight ?? 4);
  const maxWaitMs = opts.maxWaitMs ?? 30_000;
  const log = opts.logger ?? console;
  // Normally migration 005 has run; this only covers databases created from the bare table DDL.
  let ready: Promise<void> | undefined;
  const ensure = () =>
    (ready ??= (async () => {
      const present = async () =>
        (
          await pool.query(
            `SELECT (SELECT count(*) FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'alerts' AND indexname = 'alerts_open_dedup_uniq')
                  + (SELECT count(*) FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'alerts' AND column_name = 'severity_raised_by') AS n`,
          )
        ).rows[0]?.n == 2;
      if (await present()) return;
      try {
        for (const q of ENSURE_SQL) await pool.query(q);
      } catch (err) {
        if (!(await present())) throw err; // lost a race with another process doing the same
      }
    })().catch((err) => {
      // fail fast with the same error for `retryMs`, then allow one new attempt (transient PG errors heal)
      setTimeout(() => (ready = undefined), retryMs).unref();
      log.error(
        `dedup: alerts schema (migration 005) missing and could not be applied: ${(err as Error).message}`,
      );
      throw err;
    }));
  const upsertOne = async (alert: Alert): Promise<UpsertResult | null> => {
    const r = await pool.query<{ data: Alert; created: boolean; raised: boolean }>(
      `INSERT INTO alerts (id, rule_id, dedup_key, state, last_seen, data)
       SELECT $1::text, $2::text, $3::text, $4::text, $5::timestamptz, $6::jsonb
       WHERE NOT EXISTS (SELECT 1 FROM alerts WHERE id = $1::text)
       ${ON_CONFLICT_BUMP}
       RETURNING data, (xmax = 0) AS created, (severity_raised_by IS NOT DISTINCT FROM $1::text AND xmax <> 0) AS raised`,
      [alert.id, alert.ruleId, alert.dedupKey, alert.state, alert.lastSeen, JSON.stringify(alert), [...SEVERITIES]],
    );
    const row = r.rows[0];
    return row ? { alert: row.data, created: row.created, raised: row.raised } : null;
  };

  /**
   * One statement (one commit, so one WAL flush) for a whole batch of upserts with pairwise distinct
   * (ruleId, dedupKey). Results are mapped back by key; a missing row means the id existed (replay).
   */
  const upsertMany = async (alerts: Alert[]): Promise<Array<UpsertResult | null>> => {
    const r = await pool.query<{
      rule_id: string;
      dedup_key: string;
      data: Alert;
      created: boolean;
      severity_raised_by: string | null;
    }>(
      `WITH i AS (
         SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::timestamptz[], $6::jsonb[])
           AS t(id, rule_id, dedup_key, state, last_seen, data)
       )
       INSERT INTO alerts (id, rule_id, dedup_key, state, last_seen, data)
       SELECT id, rule_id, dedup_key, state, last_seen, data FROM i
       WHERE NOT EXISTS (SELECT 1 FROM alerts a WHERE a.id = i.id)
       ${ON_CONFLICT_BUMP}
       RETURNING rule_id, dedup_key, data, (xmax = 0) AS created, severity_raised_by`,
      [
        alerts.map((a) => a.id),
        alerts.map((a) => a.ruleId),
        alerts.map((a) => a.dedupKey),
        alerts.map((a) => a.state),
        alerts.map((a) => a.lastSeen),
        alerts.map((a) => JSON.stringify(a)),
        [...SEVERITIES],
      ],
    );
    const byKey = new Map(r.rows.map((row) => [batchKey(row.rule_id, row.dedup_key), row]));
    return alerts.map((a) => {
      const row = byKey.get(batchKey(a.ruleId, a.dedupKey));
      if (!row) return null;
      return { alert: row.data, created: row.created, raised: !row.created && row.severity_raised_by === a.id };
    });
  };

  // Coalescing: upserts issued while up to `maxInFlight` statements are running are sent together.
  // Calls on the same (ruleId, dedupKey) never share a statement or run concurrently, so they apply
  // in call order.
  interface Waiting {
    alert: Alert;
    key: string;
    /** When upsertOpen was called. */
    at: number;
    resolve(r: UpsertResult | null): void;
    reject(e: unknown): void;
  }
  let waiting: Waiting[] = [];
  const busyKeys = new Set<string>();
  let inFlight = 0;
  let scheduled = false;

  const expired = (w: Waiting) => Date.now() - w.at > maxWaitMs;
  const tooOld = () => new Error(`dedup: upsert not sent within ${maxWaitMs} ms, left for a retry`);

  const flush = async (batch: Waiting[]) => {
    try {
      let results: Array<UpsertResult | null>;
      try {
        results = await upsertMany(batch.map((w) => w.alert));
      } catch (err) {
        // Timeouts / lost connections fail the whole batch (the entries stay pending and are retried
        // later). Only data errors (SQLSTATE class 22/23, e.g. one bad value or a racing replay of an
        // id) are retried one by one, so one bad item fails alone. A statement is atomic: nothing of
        // the batch was applied. One at a time keeps this within the batch's slot (<= maxInFlight).
        if (batch.length === 1 || !isDataError(err)) throw err;
        for (const w of batch) {
          if (expired(w)) {
            w.reject(tooOld());
            continue;
          }
          await upsertOne(w.alert).then(w.resolve, w.reject);
        }
        return;
      }
      batch.forEach((w, i) => w.resolve(results[i] ?? null));
    } catch (err) {
      for (const w of batch) w.reject(err);
    }
  };

  const drain = () => {
    scheduled = false;
    if (waiting.some(expired)) {
      const keep: Waiting[] = [];
      for (const w of waiting) {
        if (expired(w)) w.reject(tooOld());
        else keep.push(w);
      }
      waiting = keep;
    }
    while (inFlight < maxInFlight && waiting.length > 0) {
      const batch: Waiting[] = [];
      const rest: Waiting[] = [];
      const taken = new Set<string>();
      for (const w of waiting) {
        if (batch.length < maxBatch && !busyKeys.has(w.key) && !taken.has(w.key)) {
          batch.push(w);
          taken.add(w.key);
        } else {
          // keep later calls on a key behind earlier ones
          taken.add(w.key);
          rest.push(w);
        }
      }
      if (batch.length === 0) return;
      waiting = rest;
      inFlight++;
      for (const k of taken) if (batch.some((w) => w.key === k)) busyKeys.add(k);
      void flush(batch).finally(() => {
        inFlight--;
        for (const w of batch) busyKeys.delete(w.key);
        schedule();
      });
    }
  };

  const schedule = () => {
    if (scheduled || waiting.length === 0 || inFlight >= maxInFlight) return;
    scheduled = true;
    setImmediate(drain);
  };

  return {
    async upsertOpen(alert) {
      await ensure();
      return new Promise<UpsertResult | null>((resolve, reject) => {
        waiting.push({ alert, key: batchKey(alert.ruleId, alert.dedupKey), at: Date.now(), resolve, reject });
        schedule();
      });
    },
    async resolveOpen(ruleId, dedupKey, at, common) {
      const r = await pool.query<{ data: Alert }>(
        `UPDATE alerts SET state = 'resolved', last_seen = $3::timestamptz,
           data = data || jsonb_build_object('state', 'resolved', 'resolvedAt', $4::text, 'lastSeen', $4::text, 'common', $5::jsonb)
         WHERE rule_id = $1 AND dedup_key = $2 AND state <> 'resolved' RETURNING data`,
        [ruleId, dedupKey, at, at, JSON.stringify(common)],
      );
      return r.rows[0]?.data ?? null;
    },
    async get(id) {
      const r = await pool.query<{ data: Alert }>(
        "SELECT data FROM alerts WHERE id = $1",
        [id],
      );
      return r.rows[0]?.data ?? null;
    },
    async create(alert) {
      const ins = await pool.query<{ data: Alert }>(
        `INSERT INTO alerts (id, rule_id, dedup_key, state, last_seen, data)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (id) DO NOTHING RETURNING data`,
        [
          alert.id,
          alert.ruleId,
          alert.dedupKey,
          alert.state,
          alert.lastSeen,
          JSON.stringify(alert),
        ],
      );
      if (ins.rows[0]) return { alert: ins.rows[0].data, created: true };
      const existing = await this.get(alert.id);
      return { alert: existing ?? alert, created: false };
    },
    async bump(id, input) {
      const r = await pool.query<{ data: Alert; old_sev: Severity }>(
        `WITH old AS (
           SELECT id, data->>'severity' AS sev FROM alerts WHERE id = $1 AND state <> 'resolved' FOR UPDATE
         )
         UPDATE alerts a SET
           last_seen = $2::timestamptz,
           data = a.data || jsonb_build_object(
             'count', COALESCE((a.data->>'count')::int, 0) + 1,
             'lastSeen', $3::text,
             'common', $4::jsonb,
             'severity', CASE WHEN COALESCE(array_position($5::text[], $6::text), 0) > COALESCE(array_position($5::text[], old.sev), 0)
                              THEN $6::text ELSE old.sev END)
         FROM old WHERE a.id = old.id
         RETURNING a.data, old.sev AS old_sev`,
        [
          id,
          input.lastSeen,
          input.lastSeen,
          JSON.stringify(input.common),
          [...SEVERITIES],
          input.severity,
        ],
      );
      const row = r.rows[0];
      return row ? { alert: row.data, previousSeverity: row.old_sev } : null;
    },
    async resolve(id, at, common) {
      const r = await pool.query<{ data: Alert }>(
        `UPDATE alerts SET state = 'resolved', last_seen = $2::timestamptz,
           data = data || jsonb_build_object('state', 'resolved', 'resolvedAt', $3::text, 'lastSeen', $3::text, 'common', $4::jsonb)
         WHERE id = $1 AND state <> 'resolved' RETURNING data`,
        [id, at, at, JSON.stringify(common)],
      );
      return r.rows[0]?.data ?? null;
    },
  };
}

/** In-memory repo for tests, same semantics as the Postgres one. `alerts` is exposed so tests can act as "the UI". */
export function createMemoryAlertRepo(): AlertRepo & {
  alerts: Map<string, Alert>;
} {
  const alerts = new Map<string, Alert>();
  const findOpen = (ruleId: string, dedupKey: string) => {
    for (const a of alerts.values())
      if (
        a.ruleId === ruleId &&
        a.dedupKey === dedupKey &&
        a.state !== "resolved"
      )
        return a;
    return undefined;
  };
  return {
    alerts,
    async upsertOpen(alert) {
      if (alerts.has(alert.id)) return null;
      const open = findOpen(alert.ruleId, alert.dedupKey);
      if (!open) {
        alerts.set(alert.id, structuredClone(alert));
        return { alert: structuredClone(alert), created: true, raised: false };
      }
      const raised = compareSeverity(alert.severity, open.severity) > 0;
      open.count += 1;
      if (Date.parse(alert.lastSeen) >= Date.parse(open.lastSeen)) {
        open.lastSeen = alert.lastSeen;
        open.common = structuredClone(alert.common);
      }
      if (raised) open.severity = alert.severity;
      return { alert: structuredClone(open), created: false, raised };
    },
    async resolveOpen(ruleId, dedupKey, at, common) {
      const a = findOpen(ruleId, dedupKey);
      if (!a) return null;
      a.state = "resolved";
      a.resolvedAt = at;
      a.lastSeen = at;
      a.common = structuredClone(common);
      return structuredClone(a);
    },
    async get(id) {
      const a = alerts.get(id);
      return a ? structuredClone(a) : null;
    },
    async create(alert) {
      const existing = alerts.get(alert.id);
      if (existing) return { alert: structuredClone(existing), created: false };
      alerts.set(alert.id, structuredClone(alert));
      return { alert: structuredClone(alert), created: true };
    },
    async bump(id, input) {
      const a = alerts.get(id);
      if (!a || a.state === "resolved") return null;
      const previousSeverity = a.severity;
      a.count += 1;
      a.lastSeen = input.lastSeen;
      a.common = structuredClone(input.common);
      if (compareSeverity(input.severity, a.severity) > 0)
        a.severity = input.severity;
      return { alert: structuredClone(a), previousSeverity };
    },
    async resolve(id, at, common) {
      const a = alerts.get(id);
      if (!a || a.state === "resolved") return null;
      a.state = "resolved";
      a.resolvedAt = at;
      a.lastSeen = at;
      a.common = structuredClone(common);
      return structuredClone(a);
    },
  };
}
