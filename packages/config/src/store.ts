import { Redis } from "ioredis";
import pg from "pg";
import { CHANNEL_CONFIG_CHANGE } from "@alerting/shared";
import type { ConfigChange, Group, Person, Preference, Rule, Runbook, Schema, Source } from "@alerting/shared";

export type Kind = ConfigChange["kind"];

/** Kind string -> shared entity type. */
export interface KindMap {
  source: Source;
  schema: Schema;
  rule: Rule;
  person: Person;
  group: Group;
  preference: Preference;
  runbook: Runbook;
}

export const TABLES: Record<Kind, string> = {
  source: "sources",
  schema: "schemas",
  rule: "rules",
  person: "people",
  group: "groups",
  preference: "preferences",
  runbook: "runbooks",
};

/**
 * Storage id of an entity. Preference has no `id` of its own in the shared type, so its id is
 * derived as `${ownerType}:${ownerId}` (one preference per person or group).
 */
export function entityId(kind: Kind, entity: unknown): string {
  if (typeof entity !== "object" || entity === null || Array.isArray(entity)) {
    throw new Error(`invalid ${kind}: expected an object`);
  }
  const e = entity as Record<string, unknown>;
  if (kind === "preference") {
    const { ownerType, ownerId } = e;
    if ((ownerType !== "person" && ownerType !== "group") || typeof ownerId !== "string" || ownerId === "") {
      throw new Error("invalid preference: needs ownerType ('person'|'group') and a non-empty string ownerId");
    }
    return `${ownerType}:${ownerId}`;
  }
  if (typeof e.id !== "string" || e.id === "") {
    throw new Error(`invalid ${kind}: needs a non-empty string id`);
  }
  return e.id;
}

export type ChangeHandler = (change: ConfigChange) => void;

export interface ConfigStoreOptions {
  pool?: pg.Pool;
  databaseUrl?: string;
  redis?: Redis;
  redisUrl?: string;
}

export interface ConfigStore {
  list<K extends Kind>(kind: K): Promise<KindMap[K][]>;
  get<K extends Kind>(kind: K, id: string): Promise<KindMap[K] | undefined>;
  upsert<K extends Kind>(kind: K, entity: KindMap[K]): Promise<void>;
  delete(kind: Kind, id: string): Promise<boolean>;
  onChange(kind: Kind | "*", handler: ChangeHandler): Promise<() => void>;
  close(): Promise<void>;
}

export function createConfigStore(opts: ConfigStoreOptions): ConfigStore {
  if (!opts.pool && !opts.databaseUrl) throw new Error("createConfigStore: pool or databaseUrl required");
  if (!opts.redis && !opts.redisUrl) throw new Error("createConfigStore: redis or redisUrl required");
  const ownPool = !opts.pool;
  const ownRedis = !opts.redis;
  const pool = opts.pool ?? new pg.Pool({ connectionString: opts.databaseUrl });
  const redis = opts.redis ?? new Redis(opts.redisUrl!);
  let sub: Redis | undefined;
  const handlers = new Set<{ kind: Kind | "*"; fn: ChangeHandler }>();

  const publish = (change: ConfigChange) => redis.publish(CHANNEL_CONFIG_CHANGE, JSON.stringify(change));

  async function ensureSub(): Promise<Redis> {
    if (sub) return sub;
    const s = redis.duplicate();
    sub = s;
    s.on("message", (_channel: string, message: string) => {
      let change: ConfigChange;
      try {
        change = JSON.parse(message) as ConfigChange;
      } catch {
        return;
      }
      for (const h of handlers) {
        if (h.kind === "*" || h.kind === change.kind) h.fn(change);
      }
    });
    await s.subscribe(CHANNEL_CONFIG_CHANGE);
    return s;
  }

  return {
    async list(kind) {
      const r = await pool.query(`SELECT data FROM ${TABLES[kind]} ORDER BY id`);
      return r.rows.map((row) => row.data);
    },
    async get(kind, id) {
      const r = await pool.query(`SELECT data FROM ${TABLES[kind]} WHERE id = $1`, [id]);
      return r.rows[0]?.data;
    },
    async upsert(kind, entity) {
      const id = entityId(kind, entity);
      await pool.query(
        `INSERT INTO ${TABLES[kind]} (id, data) VALUES ($1, $2::jsonb)
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [id, JSON.stringify(entity)],
      );
      await publish({ kind, id, op: "upsert" });
    },
    async delete(kind, id) {
      const r = await pool.query(`DELETE FROM ${TABLES[kind]} WHERE id = $1`, [id]);
      const deleted = (r.rowCount ?? 0) > 0;
      if (deleted) await publish({ kind, id, op: "delete" });
      return deleted;
    },
    async onChange(kind, fn) {
      const h = { kind, fn };
      handlers.add(h);
      await ensureSub();
      return () => {
        handlers.delete(h);
      };
    },
    async close() {
      handlers.clear();
      if (sub) sub.disconnect();
      if (ownRedis) await redis.quit();
      if (ownPool) await pool.end();
    },
  };
}
