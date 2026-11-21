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

// Same as migration 006 (minus the seed from existing open alerts).
const ENSURE_SQL = [
  "ALTER TABLE alerts ADD COLUMN IF NOT EXISTS severity_raised_by text",
  "CREATE TABLE IF NOT EXISTS alert_open_keys (rule_id text NOT NULL, dedup_key text NOT NULL, alert_id text NOT NULL, PRIMARY KEY (rule_id, dedup_key))",
];

/** SQLSTATE class 22 (data exception) or 23 (integrity constraint violation). */
const isDataError = (err: unknown): boolean => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && (code.startsWith("22") || code.startsWith("23"));
};

type UpsertResult = { alert: Alert; created: boolean; raised: boolean };

const batchKey = (ruleId: string, dedupKey: string) => `${ruleId}\u0000${dedupKey}`;

// The engine's open alert per (rule, dedup key) lives in `alert_open_keys`, not in a unique index on
// `alerts`, so other writers of `alerts` (API, fixtures, seed) may hold any number of open alerts
// with the same key. One statement per batch:
//   f    events not applied before (their deterministic alert id does not exist: replay guard)
//   k    claim the key for the event's own alert id, or lock and return the alert already mapped
//        (ON CONFLICT sees and waits for concurrent writers, so the key is serialized across workers)
//   ins  the key is ours: insert the alert
//   upd  the key maps to another alert: count+1, lastSeen, raise severity, unless it is resolved
// A fresh event that was neither inserted nor applied has a stale mapping (alert resolved, e.g. by the
// API, or deleted) or mapped an alert committed after this statement's snapshot; see upsertMany.
const upsertSql = (input: string) => `WITH i AS (${input}),
       f AS (SELECT * FROM i WHERE NOT EXISTS (SELECT 1 FROM alerts a WHERE a.id = i.id)),
       k AS (
         INSERT INTO alert_open_keys AS k (rule_id, dedup_key, alert_id)
         -- fixed lock order, so two batches sharing keys cannot deadlock
         SELECT rule_id, dedup_key, id FROM f ORDER BY rule_id, dedup_key
         ON CONFLICT (rule_id, dedup_key) DO UPDATE SET alert_id = k.alert_id
         RETURNING k.rule_id, k.dedup_key, k.alert_id
       ),
       fk AS (
         SELECT f.*, k.alert_id AS open_id FROM f JOIN k ON k.rule_id = f.rule_id AND k.dedup_key = f.dedup_key
       ),
       ins AS (
         INSERT INTO alerts (id, rule_id, dedup_key, state, last_seen, data)
         SELECT id, rule_id, dedup_key, state, last_seen, data FROM fk WHERE open_id = id
         ORDER BY rule_id, dedup_key
         -- the same event id applied concurrently (redelivery race) on a new key: replay, not an error
         ON CONFLICT (id) DO NOTHING
         RETURNING id, data
       ),
       upd AS (
         UPDATE alerts al SET
           last_seen = GREATEST(al.last_seen, fk.last_seen),
           severity_raised_by = CASE
             WHEN COALESCE(array_position($7::text[], fk.data->>'severity'), 0) > COALESCE(array_position($7::text[], al.data->>'severity'), 0)
             THEN fk.id ELSE al.severity_raised_by END,
           data = al.data || jsonb_build_object(
             'count', COALESCE((al.data->>'count')::int, 0) + 1,
             'lastSeen', CASE WHEN fk.last_seen >= al.last_seen THEN fk.data->>'lastSeen' ELSE al.data->>'lastSeen' END,
             'common', CASE WHEN fk.last_seen >= al.last_seen THEN fk.data->'common' ELSE al.data->'common' END,
             'severity', CASE
               WHEN COALESCE(array_position($7::text[], fk.data->>'severity'), 0) > COALESCE(array_position($7::text[], al.data->>'severity'), 0)
               THEN fk.data->>'severity' ELSE al.data->>'severity' END)
         FROM (SELECT * FROM fk ORDER BY rule_id, dedup_key) fk
         WHERE fk.open_id <> fk.id AND al.id = fk.open_id AND al.state <> 'resolved'
         RETURNING fk.id AS input_id, al.data, al.severity_raised_by IS NOT DISTINCT FROM fk.id AS raised
       )
       SELECT i.id, fk.id IS NOT NULL AS fresh, fk.rule_id, fk.dedup_key, fk.open_id,
              ins.data AS created_data, upd.data AS bumped_data, COALESCE(upd.raised, false) AS raised
       FROM i
       LEFT JOIN fk ON fk.id = i.id
       LEFT JOIN ins ON ins.id = i.id
       LEFT JOIN upd ON upd.input_id = i.id`;
const UPSERT_BATCH_SQL = upsertSql(`
         SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::timestamptz[], $6::jsonb[])
           AS t(id, rule_id, dedup_key, state, last_seen, data)`);
/** Same for one alert (scalar parameters): used to retry the items of a failed batch one by one. */
const UPSERT_ONE_SQL = upsertSql(`
         SELECT $1::text AS id, $2::text AS rule_id, $3::text AS dedup_key, $4::text AS state,
                $5::timestamptz AS last_seen, $6::jsonb AS data`);

// Drop mappings to alerts that are resolved or gone; mappings to an open alert stay (that event only
// raced a concurrent create and is simply retried).
const DROP_STALE_SQL = `WITH s AS (
         SELECT * FROM unnest($1::text[], $2::text[], $3::text[]) AS t(rule_id, dedup_key, alert_id)
       )
       DELETE FROM alert_open_keys k USING s
       WHERE k.rule_id = s.rule_id AND k.dedup_key = s.dedup_key AND k.alert_id = s.alert_id
         AND NOT EXISTS (SELECT 1 FROM alerts a WHERE a.id = s.alert_id AND a.state <> 'resolved')`;

/** Retries of the items of one batch whose mapping was stale or raced (normally at most one). */
const MAX_UPSERT_ROUNDS = 4;

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
  // Normally migration 006 has run; this only covers databases created from the bare table DDL.
  let ready: Promise<void> | undefined;
  const ensure = () =>
    (ready ??= (async () => {
      const present = async () =>
        (
          await pool.query(
            `SELECT (SELECT count(*) FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'alert_open_keys' AND indexname = 'alert_open_keys_pkey')
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
        `dedup: alerts schema (migration 006) missing and could not be applied: ${(err as Error).message}`,
      );
      throw err;
    }));
  type Row = {
    id: string;
    fresh: boolean;
    rule_id: string | null;
    dedup_key: string | null;
    open_id: string | null;
    created_data: Alert | null;
    bumped_data: Alert | null;
    raised: boolean;
  };

  /**
   * Create-or-bump for a batch with pairwise distinct (ruleId, dedupKey): one statement (one commit)
   * in the normal case. Null for an event applied before (replay).
   */
  const upsertMany = async (alerts: Alert[], single = false): Promise<Array<UpsertResult | null>> => {
    const out = new Array<UpsertResult | null>(alerts.length).fill(null);
    let todo = alerts.map((alert, i) => ({ alert, i }));
    for (let round = 0; todo.length > 0; round++) {
      if (round >= MAX_UPSERT_ROUNDS)
        throw new Error(`dedup: open alert of ${todo[0]!.alert.ruleId}/${todo[0]!.alert.dedupKey} kept changing, retry later`);
      const one = todo.length === 1 && single;
      const col = (f: (a: Alert) => unknown) => (one ? f(todo[0]!.alert) : todo.map((t) => f(t.alert)));
      const r = await pool.query<Row>(one ? UPSERT_ONE_SQL : UPSERT_BATCH_SQL, [
        col((a) => a.id),
        col((a) => a.ruleId),
        col((a) => a.dedupKey),
        col((a) => a.state),
        col((a) => a.lastSeen),
        col((a) => JSON.stringify(a)),
        [...SEVERITIES],
      ]);
      const byId = new Map(r.rows.map((row) => [row.id, row]));
      const again: typeof todo = [];
      const stale: Row[] = [];
      for (const t of todo) {
        const row = byId.get(t.alert.id);
        if (!row || !row.fresh) continue; // replay: stays null
        if (row.created_data) out[t.i] = { alert: row.created_data, created: true, raised: false };
        else if (row.open_id === t.alert.id) continue; // its own id won by a concurrent delivery: replay
        else if (row.bumped_data) out[t.i] = { alert: row.bumped_data, created: false, raised: row.raised };
        else {
          again.push(t);
          stale.push(row);
        }
      }
      if (stale.length > 0)
        await pool.query(DROP_STALE_SQL, [
          stale.map((s) => s.rule_id),
          stale.map((s) => s.dedup_key),
          stale.map((s) => s.open_id),
        ]);
      todo = again;
    }
    return out;
  };
  const upsertOne = async (alert: Alert) => (await upsertMany([alert], true))[0] ?? null;

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
      await ensure();
      // $1 = resolvedAt, $2 = common
      const set = `state = 'resolved', last_seen = $1::timestamptz,
           data = data || jsonb_build_object('state', 'resolved', 'resolvedAt', $1::text, 'lastSeen', $1::text, 'common', $2::jsonb)`;
      // the key row is the lock: unmap and resolve the engine's open alert of this key together
      const r = await pool.query<{ alert_id: string | null; data: Alert | null }>(
        `WITH k AS (DELETE FROM alert_open_keys WHERE rule_id = $3 AND dedup_key = $4 RETURNING alert_id),
              u AS (UPDATE alerts SET ${set} WHERE id IN (SELECT alert_id FROM k) AND state <> 'resolved' RETURNING data)
         SELECT (SELECT alert_id FROM k) AS alert_id, (SELECT data FROM u) AS data`,
        [at, JSON.stringify(common), ruleId, dedupKey],
      );
      const row = r.rows[0];
      if (row?.data) return row.data;
      if (!row?.alert_id) return null;
      // mapped alert committed after this statement's snapshot: resolve it by id in a new one
      const again = await pool.query<{ data: Alert }>(
        `UPDATE alerts SET ${set} WHERE id = $3 AND state <> 'resolved' RETURNING data`,
        [at, JSON.stringify(common), row.alert_id],
      );
      return again.rows[0]?.data ?? null;
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
