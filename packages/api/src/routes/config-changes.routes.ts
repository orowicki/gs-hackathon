import type { RouteModule } from "../http.js";
import { send } from "../http.js";
import { CHANGE_KINDS, changesOf, type ConfigChangeStore } from "./config/changes.js";

declare module "../http.js" {
  interface Deps {
    /** Config change log override (tests). Default: Postgres when `pool` is set, else in memory. */
    changes?: ConfigChangeStore;
  }
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

export default {
  name: "config-changes",
  order: 31,
  async handle({ req, res, path, url, deps }) {
    if (path !== "/api/config/changes" || req.method !== "GET") return false;
    const kind = url.searchParams.get("kind") ?? undefined;
    if (kind !== undefined && !(CHANGE_KINDS as readonly string[]).includes(kind)) {
      send(res, 400, { error: `kind must be one of: ${CHANGE_KINDS.join(", ")}` });
      return true;
    }
    const rawLimit = url.searchParams.get("limit");
    let limit = DEFAULT_LIMIT;
    if (rawLimit !== null) {
      if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1) {
        send(res, 400, { error: "limit must be a positive integer" });
        return true;
      }
      limit = Math.min(Number(rawLimit), MAX_LIMIT);
    }
    const rows = await changesOf(deps).list({ kind, id: url.searchParams.get("id") ?? undefined, limit });
    // Actor names come from the config store's people; a deleted person falls back to the id.
    const names = new Map<string, string>();
    for (const a of new Set(rows.flatMap((r) => (r.actor === null ? [] : [r.actor])))) {
      const p = deps.config ? ((await deps.config.get("person", a).catch(() => undefined)) as { name?: string } | undefined) : undefined;
      names.set(a, p?.name ?? a);
    }
    send(res, 200, {
      changes: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        itemId: r.itemId,
        action: r.action,
        actor: r.actor === null ? null : { id: r.actor, name: names.get(r.actor) ?? r.actor },
        occurredAt: r.occurredAt,
      })),
    });
    return true;
  },
} satisfies RouteModule;
