import type { SqlPool } from "../accounts/sessions.js";

/** Kinds recorded in the change log (the kind names of the config router). */
export const CHANGE_KINDS = ["source", "schema", "rule", "person", "group", "runbook"] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];
export type ChangeAction = "create" | "update" | "delete" | "import";

export interface ConfigChangeInput {
  kind: ChangeKind;
  id: string;
  action: ChangeAction;
  /** Person id of the signed-in account; undefined/null without one. */
  actor?: string | null;
}

export interface ConfigChangeRow {
  id: number;
  kind: string;
  itemId: string;
  action: ChangeAction;
  actor: string | null;
  occurredAt: string;
}

export interface ConfigChangeStore {
  record(change: ConfigChangeInput): Promise<void>;
  /** Newest first. */
  list(opts: { kind?: string; id?: string; limit: number }): Promise<ConfigChangeRow[]>;
}

export function createMemoryChanges(): ConfigChangeStore {
  const rows: ConfigChangeRow[] = [];
  let next = 1;
  return {
    async record(c) {
      rows.push({
        id: next++,
        kind: c.kind,
        itemId: c.id,
        action: c.action,
        actor: c.actor ?? null,
        occurredAt: new Date().toISOString(),
      });
    },
    async list({ kind, id, limit }) {
      return rows
        .filter((r) => (kind === undefined || r.kind === kind) && (id === undefined || r.itemId === id))
        .reverse()
        .slice(0, limit);
    },
  };
}

/** Postgres-backed log; the table comes from migration 005_config_changes.sql. */
export function createPgChanges(pool: SqlPool): ConfigChangeStore {
  return {
    async record(c) {
      await pool.query("INSERT INTO config_changes (kind, item_id, action, actor) VALUES ($1, $2, $3, $4)", [
        c.kind,
        c.id,
        c.action,
        c.actor ?? null,
      ]);
    },
    async list({ kind, id, limit }) {
      const { rows } = await pool.query(
        `SELECT id, kind, item_id, action, actor, occurred_at FROM config_changes
         WHERE ($1::text IS NULL OR kind = $1) AND ($2::text IS NULL OR item_id = $2)
         ORDER BY occurred_at DESC, id DESC LIMIT $3`,
        [kind ?? null, id ?? null, limit],
      );
      return rows.map((r) => ({
        id: Number(r.id),
        kind: r.kind as string,
        itemId: r.item_id as string,
        action: r.action as ChangeAction,
        actor: (r.actor as string | null) ?? null,
        occurredAt: new Date(r.occurred_at as string | Date).toISOString(),
      }));
    },
  };
}

const fallback = new WeakMap<object, ConfigChangeStore>();

/** The change store of the deps: the given one, else Postgres when there is a pool, else in memory. */
export function changesOf(deps: { changes?: ConfigChangeStore; pool?: SqlPool }): ConfigChangeStore {
  if (deps.changes) return deps.changes;
  let s = fallback.get(deps);
  if (!s) fallback.set(deps, (s = deps.pool ? createPgChanges(deps.pool) : createMemoryChanges()));
  return s;
}

/** Records a change; a failure is logged and never fails the write that already happened. */
export async function recordChange(store: ConfigChangeStore | undefined, change: ConfigChangeInput): Promise<void> {
  if (!store) return;
  try {
    await store.record(change);
  } catch (err) {
    console.warn(
      `config changes: could not record ${change.action} ${change.kind}/${change.id}:`,
      err instanceof Error ? err.message : err,
    );
  }
}
