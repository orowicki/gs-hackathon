import type { ConfigStore } from "@alerting/config";
import type { Logger } from "./rules/compile.js";

export interface LiveTracker {
  ready: Promise<void>;
  close(): void;
}

/**
 * Keeps a local view in sync with one config kind.
 * - Change events are handled strictly one at a time (promise chain), in arrival order.
 * - Every event gets a sequence number; a `get` result is only applied if no later event for
 *   the same id has arrived since.
 * - Ids touched by an event during the initial list are never overwritten by the (possibly
 *   stale) list snapshot.
 */
export function trackConfig(
  store: ConfigStore,
  kind: "rule" | "person" | "group" | "preference",
  opts: {
    logger: Logger;
    label: string;
    /** Called with the entity, or undefined to remove. */
    put(id: string, entity: unknown | undefined): void;
    /** Id of an entity returned by list(). */
    idOf(entity: unknown): string;
  },
): LiveTracker {
  let closed = false;
  let loading = true;
  let unsub: (() => void) | undefined;
  let seq = 0;
  const latest = new Map<string, number>();
  const touched = new Set<string>();
  let chain: Promise<void> = Promise.resolve();

  const handle = async (id: string, op: string, mine: number) => {
    if (closed) return;
    try {
      if (op === "delete") {
        if (latest.get(id) === mine) opts.put(id, undefined);
        return;
      }
      const e = await store.get(kind, id);
      if (closed || latest.get(id) !== mine) return;
      opts.put(id, e ?? undefined);
    } catch (err) {
      opts.logger.error(`${opts.label}: failed to apply ${kind} change ${id}: ${(err as Error).message}`);
    }
  };

  const ready = (async () => {
    // Subscribe first so changes during the initial load are not lost.
    const u = await store.onChange(kind, (change) => {
      if (closed) return;
      const mine = ++seq;
      latest.set(change.id, mine);
      if (loading) touched.add(change.id);
      chain = chain.then(() => handle(change.id, change.op, mine));
      return chain;
    });
    if (closed) u();
    else unsub = u;
    const all = (await store.list(kind)) as unknown[];
    for (const e of all) {
      const id = opts.idOf(e);
      if (!touched.has(id)) opts.put(id, e);
    }
    loading = false;
    touched.clear();
  })();

  return {
    ready,
    close() {
      closed = true;
      unsub?.();
    },
  };
}
