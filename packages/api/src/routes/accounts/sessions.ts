import { randomBytes } from "node:crypto";

/** Server-side sessions: opaque random token -> person id. */
export interface SessionStore {
  create(personId: string): Promise<string>;
  get(token: string): Promise<string | undefined>;
  delete(token: string): Promise<void>;
}

export interface SqlPool {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const newToken = (): string => randomBytes(32).toString("hex");

export function createMemorySessions(): SessionStore {
  const m = new Map<string, string>();
  return {
    async create(personId) {
      const t = newToken();
      m.set(t, personId);
      return t;
    },
    async get(token) {
      return m.get(token);
    },
    async delete(token) {
      m.delete(token);
    },
  };
}

/** Postgres-backed sessions (survive API restarts). The table is created on first use. */
export function createPgSessions(pool: SqlPool): SessionStore {
  let ready: Promise<unknown> | undefined;
  const init = (): Promise<unknown> =>
    (ready ??= pool
      .query(
        "CREATE TABLE IF NOT EXISTS account_sessions (token text PRIMARY KEY, person_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())",
      )
      .catch((e: unknown) => {
        ready = undefined;
        throw e;
      }));
  return {
    async create(personId) {
      await init();
      const t = newToken();
      await pool.query("INSERT INTO account_sessions (token, person_id) VALUES ($1, $2)", [t, personId]);
      return t;
    },
    async get(token) {
      await init();
      const r = await pool.query("SELECT person_id FROM account_sessions WHERE token = $1", [token]);
      const v = r.rows[0]?.person_id;
      return typeof v === "string" ? v : undefined;
    },
    async delete(token) {
      await init();
      await pool.query("DELETE FROM account_sessions WHERE token = $1", [token]);
    },
  };
}
