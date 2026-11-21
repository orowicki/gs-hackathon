import type { Pool, PoolClient } from "pg";
import { migrate } from "@alerting/config";
import type { Alert, AlertState, AuditEntry, Event, Severity, Suggestion } from "@alerting/shared";

export interface AlertCursor {
  lastSeen: string;
  id: string;
}

export type AlertSort = "lastSeen" | "firstSeen" | "severity" | "count";
export type SortOrder = "asc" | "desc";

export interface AlertListQuery {
  state?: AlertState;
  before?: AlertCursor;
  limit: number;
  /** Non-default sorts order by (key, id) in the same direction; `before` only applies to lastSeen desc. */
  sort?: AlertSort;
  order?: SortOrder;
  offset?: number;
}

export interface AlertSummary {
  open: number;
  bySeverity: Record<Severity, number>;
  byStatus: Record<AlertState, number>;
}

export function emptySummary(): AlertSummary {
  return {
    open: 0,
    bySeverity: { critical: 0, error: 0, warning: 0, info: 0 },
    byStatus: { open: 0, acknowledged: 0, resolved: 0 },
  };
}

/** bySeverity counts open alerts only; byStatus counts all. */
export function addToSummary(s: AlertSummary, a: { state: AlertState; severity: Severity }): void {
  s.byStatus[a.state] = (s.byStatus[a.state] ?? 0) + 1;
  if (a.state === "open") {
    s.open++;
    s.bySeverity[a.severity] = (s.bySeverity[a.severity] ?? 0) + 1;
  }
}

const SEVERITY_RANK: Record<string, number> = { critical: 4, error: 3, warning: 2, info: 1 };

export interface AlertStore {
  get(id: string): Promise<Alert | null>;
  /** Newest first: lastSeen desc, then id desc. */
  list(q: AlertListQuery): Promise<Alert[]>;
  /** Counts of all alerts in a single aggregate query (no filter). */
  summary(): Promise<AlertSummary>;
  upsert(alert: Alert): Promise<void>;
  /** Atomic: applies `patch` only if the current state is in `from`. */
  transition(id: string, from: AlertState[], patch: Partial<Alert>): Promise<Alert | null | "conflict">;
  /** Like `transition`, but the audit row is written in the same transaction (all or nothing). */
  transitionWithAudit(
    id: string,
    from: AlertState[],
    patch: Partial<Alert>,
    entry: AuditEntry,
  ): Promise<Alert | null | "conflict">;
}

export interface AuditListQuery {
  alertId?: string;
  actor?: string;
  action?: string;
  before?: AuditCursor;
  limit: number;
}

export interface AuditCursor {
  at: string;
  id: string;
}

export interface AuditStore {
  append(entry: AuditEntry): Promise<void>;
  /** Oldest first. */
  listByAlert(alertId: string): Promise<AuditEntry[]>;
  /** Newest first. */
  list(q: AuditListQuery): Promise<AuditEntry[]>;
}

export interface SuggestionStore {
  create(s: Suggestion): Promise<void>;
  /** Insert the suggestion and its audit row in one transaction. */
  createWithAudit(s: Suggestion, entry: AuditEntry): Promise<void>;
  get(id: string): Promise<Suggestion | null>;
  /** Newest first. */
  listByRule(ruleId: string, status?: Suggestion["status"]): Promise<Suggestion[]>;
  listByAlert(alertId: string): Promise<Suggestion[]>;
  setStatus(
    id: string,
    from: "open",
    to: "accepted" | "dismissed",
  ): Promise<Suggestion | null | "conflict">;
}

export interface EventLoader {
  getEvents(ids: string[]): Promise<Map<string, Event>>;
}

export interface AlertStores {
  alerts: AlertStore;
  audit: AuditStore;
  suggestions: SuggestionStore;
}

const ms = (iso: string): number => Date.parse(iso);

function cmpNewest(a: { lastSeen: string; id: string }, b: { lastSeen: string; id: string }): number {
  const d = ms(b.lastSeen) - ms(a.lastSeen);
  if (d !== 0) return d;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

function sortKey(a: Alert, sort: AlertSort): number {
  if (sort === "severity") return SEVERITY_RANK[a.severity] ?? 0;
  if (sort === "count") return a.count ?? 0;
  const v = ms((sort === "firstSeen" ? a.firstSeen : a.lastSeen) ?? "");
  return Number.isNaN(v) ? 0 : v;
}

function cmpSorted(sort: AlertSort, order: SortOrder): (a: Alert, b: Alert) => number {
  const dir = order === "asc" ? 1 : -1;
  return (a, b) => {
    const d = sortKey(a, sort) - sortKey(b, sort);
    if (d !== 0) return d * dir;
    return (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) * dir;
  };
}

function cmpAuditNewest(a: { at: string; id: string }, b: { at: string; id: string }): number {
  const d = ms(b.at) - ms(a.at);
  if (d !== 0) return d;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export function createMemoryAlertStores(): AlertStores & { events: Map<string, Event> } {
  const alerts = new Map<string, Alert>();
  const audit: AuditEntry[] = [];
  const suggestions = new Map<string, Suggestion>();
  const events = new Map<string, Event>();
  return {
    events,
    alerts: {
      async get(id) {
        const a = alerts.get(id);
        return a ? structuredClone(a) : null;
      },
      async list(q) {
        const custom = q.sort !== undefined || q.order !== undefined;
        let all = [...alerts.values()].sort(custom ? cmpSorted(q.sort ?? "lastSeen", q.order ?? "desc") : cmpNewest);
        if (q.state) all = all.filter((a) => a.state === q.state);
        if (q.before) {
          const b = q.before;
          all = all.filter((a) => cmpNewest(b, a) < 0);
        }
        const off = q.offset ?? 0;
        return structuredClone(all.slice(off, off + q.limit));
      },
      async summary() {
        const out = emptySummary();
        for (const a of alerts.values()) addToSummary(out, a);
        return out;
      },
      async upsert(alert) {
        alerts.set(alert.id, structuredClone(alert));
      },
      async transition(id, from, patch) {
        const cur = alerts.get(id);
        if (!cur) return null;
        if (!from.includes(cur.state)) return "conflict";
        const next = { ...cur, ...patch };
        alerts.set(id, next);
        return structuredClone(next);
      },
      async transitionWithAudit(id, from, patch, entry) {
        const cur = alerts.get(id);
        if (!cur) return null;
        if (!from.includes(cur.state)) return "conflict";
        const next = { ...cur, ...patch };
        alerts.set(id, next);
        audit.push(structuredClone(entry));
        return structuredClone(next);
      },
    },
    audit: {
      async append(entry) {
        audit.push(structuredClone(entry));
      },
      async listByAlert(alertId) {
        return structuredClone(audit.filter((e) => e.alertId === alertId));
      },
      async list(q) {
        const b = q.before;
        const out = audit
          .filter(
            (e) =>
              (!q.alertId || e.alertId === q.alertId) &&
              (!q.actor || e.actor === q.actor) &&
              (!q.action || e.action === q.action) &&
              (!b || cmpAuditNewest(b, e) < 0),
          )
          .sort(cmpAuditNewest)
          .slice(0, q.limit);
        return structuredClone(out);
      },
    },
    suggestions: {
      async create(s) {
        suggestions.set(s.id, structuredClone(s));
      },
      async createWithAudit(s, entry) {
        suggestions.set(s.id, structuredClone(s));
        audit.push(structuredClone(entry));
      },
      async get(id) {
        const s = suggestions.get(id);
        return s ? structuredClone(s) : null;
      },
      async listByRule(ruleId, status) {
        const out = [...suggestions.values()]
          .filter((s) => s.ruleId === ruleId && (!status || s.status === status))
          .sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
        return structuredClone(out);
      },
      async listByAlert(alertId) {
        const out = [...suggestions.values()]
          .filter((s) => s.alertId === alertId)
          .sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
        return structuredClone(out);
      },
      async setStatus(id, from, to) {
        const cur = suggestions.get(id);
        if (!cur) return null;
        if (cur.status !== from) return "conflict";
        const next = { ...cur, status: to };
        suggestions.set(id, next);
        return structuredClone(next);
      },
    },
  };
}

export function memoryEventLoader(events: Map<string, Event>): EventLoader {
  return {
    async getEvents(ids) {
      const out = new Map<string, Event>();
      for (const id of ids) {
        const e = events.get(id);
        if (e) out.set(id, e);
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------- Postgres

interface DataRow<T> {
  data: T;
}

export function createPgAlertStores(pool: Pool): AlertStores {
  let ready: Promise<unknown> | undefined;
  const q = async <T extends object>(text: string, params: unknown[] = []): Promise<T[]> => {
    ready ??= migrate(pool).catch((e: unknown) => {
      ready = undefined;
      throw e;
    });
    await ready;
    return (await pool.query<T>(text, params)).rows;
  };
  const tx = async <T>(fn: (c: PoolClient) => Promise<T>): Promise<T> => {
    ready ??= migrate(pool).catch((e: unknown) => {
      ready = undefined;
      throw e;
    });
    await ready;
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const out = await fn(c);
      await c.query("COMMIT");
      return out;
    } catch (e) {
      try {
        await c.query("ROLLBACK");
      } catch {
        /* connection is broken; release below */
      }
      throw e;
    } finally {
      c.release();
    }
  };
  const insertAudit = (c: PoolClient, e: AuditEntry): Promise<unknown> =>
    c.query("INSERT INTO alert_audit (id, alert_id, at, actor, action, data) VALUES ($1,$2,$3,$4,$5,$6)", [
      e.id,
      e.alertId,
      e.at,
      e.actor,
      e.action,
      JSON.stringify(e),
    ]);
  const datas = <T>(rows: DataRow<T>[]): T[] => rows.map((r) => r.data);

  const alerts: AlertStore = {
    async get(id) {
      return datas(await q<DataRow<Alert>>("SELECT data FROM alerts WHERE id = $1", [id]))[0] ?? null;
    },
    async list({ state, before, limit, sort, order, offset }) {
      const params: unknown[] = [];
      const where: string[] = [];
      if (state) {
        params.push(state);
        where.push(`state = $${params.length}`);
      }
      if (before) {
        params.push(before.lastSeen, before.id);
        where.push(`(last_seen, id) < ($${params.length - 1}::timestamptz, $${params.length})`);
      }
      let orderBy = "last_seen DESC, id DESC";
      if (sort !== undefined || order !== undefined) {
        const dir = order === "asc" ? "ASC" : "DESC";
        const key =
          sort === "firstSeen"
            ? "COALESCE((data->>'firstSeen')::timestamptz, 'epoch'::timestamptz)"
            : sort === "count"
              ? "COALESCE((data->>'count')::numeric, 0)"
              : sort === "severity"
                ? "CASE data->>'severity' WHEN 'critical' THEN 4 WHEN 'error' THEN 3 WHEN 'warning' THEN 2 WHEN 'info' THEN 1 ELSE 0 END"
                : "last_seen";
        orderBy = `${key} ${dir}, id ${dir}`;
      }
      params.push(limit);
      let sql = `SELECT data FROM alerts ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ${orderBy} LIMIT $${params.length}`;
      if (offset) {
        params.push(offset);
        sql += ` OFFSET $${params.length}`;
      }
      return datas(await q<DataRow<Alert>>(sql, params));
    },
    async summary() {
      const [r] = await q<Record<string, string>>(
        `SELECT count(*) FILTER (WHERE state = 'open') AS open,
           count(*) FILTER (WHERE state = 'acknowledged') AS acknowledged,
           count(*) FILTER (WHERE state = 'resolved') AS resolved,
           count(*) FILTER (WHERE state = 'open' AND data->>'severity' = 'critical') AS critical,
           count(*) FILTER (WHERE state = 'open' AND data->>'severity' = 'error') AS error,
           count(*) FILTER (WHERE state = 'open' AND data->>'severity' = 'warning') AS warning,
           count(*) FILTER (WHERE state = 'open' AND data->>'severity' = 'info') AS info
         FROM alerts`,
      );
      const n = (k: string): number => Number(r?.[k] ?? 0);
      return {
        open: n("open"),
        bySeverity: { critical: n("critical"), error: n("error"), warning: n("warning"), info: n("info") },
        byStatus: { open: n("open"), acknowledged: n("acknowledged"), resolved: n("resolved") },
      };
    },
    async upsert(a) {
      await q(
        `INSERT INTO alerts (id, rule_id, dedup_key, state, last_seen, data) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (id) DO UPDATE SET rule_id = EXCLUDED.rule_id, dedup_key = EXCLUDED.dedup_key,
           state = EXCLUDED.state, last_seen = EXCLUDED.last_seen, data = EXCLUDED.data`,
        [a.id, a.ruleId, a.dedupKey, a.state, a.lastSeen, JSON.stringify(a)],
      );
    },
    async transition(id, from, patch) {
      const rows = await q<DataRow<Alert>>(
        `UPDATE alerts SET data = data || $3::jsonb,
           state = COALESCE($3::jsonb->>'state', state),
           last_seen = COALESCE(($3::jsonb->>'lastSeen')::timestamptz, last_seen)
         WHERE id = $1 AND state = ANY($2) RETURNING data`,
        [id, from, JSON.stringify(patch)],
      );
      if (rows[0]) return rows[0].data;
      const exists = await q("SELECT 1 FROM alerts WHERE id = $1", [id]);
      return exists.length ? "conflict" : null;
    },
    async transitionWithAudit(id, from, patch, entry) {
      return tx(async (c) => {
        const r = await c.query<DataRow<Alert>>(
          `UPDATE alerts SET data = data || $3::jsonb,
             state = COALESCE($3::jsonb->>'state', state),
             last_seen = COALESCE(($3::jsonb->>'lastSeen')::timestamptz, last_seen)
           WHERE id = $1 AND state = ANY($2) RETURNING data`,
          [id, from, JSON.stringify(patch)],
        );
        if (r.rows[0]) {
          await insertAudit(c, entry);
          return r.rows[0].data;
        }
        const exists = await c.query("SELECT 1 FROM alerts WHERE id = $1", [id]);
        return exists.rows.length ? ("conflict" as const) : null;
      });
    },
  };

  const audit: AuditStore = {
    async append(e) {
      await q(
        "INSERT INTO alert_audit (id, alert_id, at, actor, action, data) VALUES ($1,$2,$3,$4,$5,$6)",
        [e.id, e.alertId, e.at, e.actor, e.action, JSON.stringify(e)],
      );
    },
    async listByAlert(alertId) {
      return datas(
        await q<DataRow<AuditEntry>>(
          "SELECT data FROM alert_audit WHERE alert_id = $1 ORDER BY at ASC, id ASC",
          [alertId],
        ),
      );
    },
    async list(f) {
      const params: unknown[] = [];
      const where: string[] = [];
      const add = (col: string, v: unknown, cast = ""): void => {
        params.push(v);
        where.push(`${col}${cast ? " <" : " ="} $${params.length}${cast}`);
      };
      if (f.alertId) add("alert_id", f.alertId);
      if (f.actor) add("actor", f.actor);
      if (f.action) add("action", f.action);
      if (f.before) {
        params.push(f.before.at, f.before.id);
        where.push(`(at, id) < ($${params.length - 1}::timestamptz, $${params.length})`);
      }
      params.push(f.limit);
      const sql = `SELECT data FROM alert_audit ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY at DESC, id DESC LIMIT $${params.length}`;
      return datas(await q<DataRow<AuditEntry>>(sql, params));
    },
  };

  const suggestions: SuggestionStore = {
    async create(s) {
      await q(
        "INSERT INTO suggestions (id, rule_id, alert_id, status, created_at, data) VALUES ($1,$2,$3,$4,$5,$6)",
        [s.id, s.ruleId, s.alertId ?? null, s.status, s.createdAt, JSON.stringify(s)],
      );
    },
    async get(id) {
      return datas(await q<DataRow<Suggestion>>("SELECT data FROM suggestions WHERE id = $1", [id]))[0] ?? null;
    },
    async createWithAudit(s, entry) {
      await tx(async (c) => {
        await c.query(
          "INSERT INTO suggestions (id, rule_id, alert_id, status, created_at, data) VALUES ($1,$2,$3,$4,$5,$6)",
          [s.id, s.ruleId, s.alertId ?? null, s.status, s.createdAt, JSON.stringify(s)],
        );
        await insertAudit(c, entry);
      });
    },
    async listByRule(ruleId, status) {
      const params: unknown[] = [ruleId];
      if (status) params.push(status);
      return datas(
        await q<DataRow<Suggestion>>(
          `SELECT data FROM suggestions WHERE rule_id = $1 ${status ? "AND status = $2" : ""} ORDER BY created_at DESC, id DESC`,
          params,
        ),
      );
    },
    async listByAlert(alertId) {
      return datas(
        await q<DataRow<Suggestion>>(
          "SELECT data FROM suggestions WHERE alert_id = $1 ORDER BY created_at DESC, id DESC",
          [alertId],
        ),
      );
    },
    async setStatus(id, from, to) {
      const rows = await q<DataRow<Suggestion>>(
        `UPDATE suggestions SET status = $3, data = jsonb_set(data, '{status}', to_jsonb($3::text))
         WHERE id = $1 AND status = $2 RETURNING data`,
        [id, from, to],
      );
      if (rows[0]) return rows[0].data;
      const exists = await q("SELECT 1 FROM suggestions WHERE id = $1", [id]);
      return exists.length ? "conflict" : null;
    },
  };

  return { alerts, audit, suggestions };
}

/** Reads ingest's `events` table; an absent table yields no events. */
export function createPgEventLoader(pool: Pool): EventLoader {
  interface Row {
    id: string;
    source_id: string;
    received_at: Date | string;
    raw: unknown;
    parsed: unknown;
    schema_id: string | null;
    common: unknown;
  }
  return {
    async getEvents(ids) {
      const out = new Map<string, Event>();
      if (ids.length === 0) return out;
      try {
        const { rows } = await pool.query<Row>(
          "SELECT id, source_id, received_at, raw, parsed, schema_id, common FROM events WHERE id = ANY($1)",
          [ids],
        );
        for (const r of rows) {
          out.set(r.id, {
            id: r.id,
            sourceId: r.source_id,
            receivedAt: new Date(r.received_at).toISOString(),
            raw: r.raw as Event["raw"],
            parsed: r.parsed as Event["parsed"],
            schemaId: r.schema_id,
            common: (r.common ?? {}) as Event["common"],
          });
        }
      } catch (e) {
        if ((e as { code?: string }).code !== "42P01") throw e;
      }
      return out;
    },
  };
}
