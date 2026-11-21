import { randomBytes } from "node:crypto";
import type http from "node:http";
import type { RouteModule } from "../http.js";
import { send } from "../http.js";
import { BodyError, readJsonBody, sendBodyError } from "./common.js";
import { setAccount } from "./accounts/actor.js";
import { createMemorySessions, createPgSessions, type SessionStore, type SqlPool } from "./accounts/sessions.js";

declare module "../http.js" {
  interface Deps {
    /** Postgres pool for the session table (accounts module creates it on first use). */
    pool?: SqlPool;
    /** Session store override (tests). Default: Postgres when `pool` is set, else in memory. */
    sessions?: SessionStore;
  }
}

export const SESSION_COOKIE = "alerting_session";
const MAX_AGE = 60 * 60 * 24 * 30;

const fallbackStores = new WeakMap<object, SessionStore>();
function sessionsOf(deps: import("../http.js").Deps): SessionStore {
  if (deps.sessions) return deps.sessions;
  let s = fallbackStores.get(deps);
  if (!s) fallbackStores.set(deps, (s = deps.pool ? createPgSessions(deps.pool) : createMemorySessions()));
  return s;
}

function cookieToken(req: http.IncomingMessage): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === SESSION_COOKIE) {
      const v = part.slice(i + 1).trim();
      return v === "" ? undefined : v;
    }
  }
  return undefined;
}

type PersonRec = { id: string; canCreateRules?: boolean } & Record<string, unknown>;

const cookie = (value: string, maxAge: number): string =>
  `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;

export default {
  name: "accounts",
  // First: resolves the account of every request so later routes (actor, rule permission) can read it.
  order: 1,
  async handle({ req, res, path, deps }) {
    const config = deps.config;
    const method = req.method ?? "GET";
    const header = req.headers["x-account"];
    const xAccount = (Array.isArray(header) ? header[0] : header)?.trim();
    const token = cookieToken(req);
    const own = path === "/api/accounts" || path === "/api/session";

    // Resolve: session cookie > X-Account.
    let person: PersonRec | undefined;
    if (config && (token || xAccount)) {
      try {
        const store = sessionsOf(deps);
        const id = token ? await store.get(token) : undefined;
        const fromSession = id ? ((await config.get("person", id)) as PersonRec | undefined) : undefined;
        person =
          fromSession ??
          (xAccount ? ((await config.get("person", xAccount)) as PersonRec | undefined) : undefined);
      } catch (e) {
        console.error("account lookup failed:", e);
        if (own) return send(res, 503, { error: "accounts unavailable" }), true;
      }
      if (person) setAccount(req, { id: person.id, canCreateRules: person.canCreateRules === true });
    }
    if (!own) return false;

    try {
      if (path === "/api/accounts") {
        if (method !== "POST") return false;
        if (!config) return send(res, 503, { error: "config store not configured" }), true;
        const body = await readJsonBody(req);
        if (typeof body.name !== "string" || body.name.trim() === "")
          return send(res, 400, { error: "name is required" }), true;
        if (body.role !== undefined && typeof body.role !== "string")
          return send(res, 400, { error: "role must be a string" }), true;
        const created = {
          id: `acc-${randomBytes(5).toString("hex")}`,
          name: body.name.trim().slice(0, 200),
          role: (body.role as string | undefined)?.trim() || "member",
          canCreateRules: false,
        };
        await config.upsert("person", created as never);
        return send(res, 201, created), true;
      }
      // /api/session
      const store = sessionsOf(deps);
      if (method === "POST") {
        if (!config) return send(res, 503, { error: "config store not configured" }), true;
        const body = await readJsonBody(req);
        if (typeof body.personId !== "string" || body.personId === "")
          return send(res, 400, { error: "personId is required" }), true;
        const p = await config.get("person", body.personId);
        if (!p) return send(res, 404, { error: `person not found: ${body.personId}` }), true;
        const t = await store.create(body.personId);
        res.setHeader("set-cookie", cookie(t, MAX_AGE));
        return send(res, 200, p), true;
      }
      if (method === "GET") {
        if (!person) return send(res, 401, { error: "not signed in" }), true;
        return send(res, 200, person), true;
      }
      if (method === "DELETE") {
        if (token) await store.delete(token);
        res.writeHead(204, { "set-cookie": cookie("", 0) });
        res.end();
        return true;
      }
      return false;
    } catch (e) {
      if (e instanceof BodyError) return sendBodyError(req, res, e), true;
      throw e;
    }
  },
} satisfies RouteModule;
