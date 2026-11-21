import type { ConfigStore } from "@alerting/config";
import type { Schema } from "@alerting/shared";
import { classifyEvent, compileMatch, type Classification } from "./classify.js";

export interface SchemaRegistry {
  ready: Promise<void>;
  classify(parsed: unknown): Classification;
  schemas(): Schema[];
  close(): void;
}

export interface RegistryOptions {
  onError?: (err: Error, schemaId?: string) => void;
}

function valid(s: unknown): s is Schema {
  if (typeof s !== "object" || s === null) return false;
  const e = s as Record<string, unknown>;
  return typeof e.id === "string" && typeof e.mapping === "object" && e.mapping !== null && e.match !== undefined;
}

/**
 * Live view of the stored schemas. Loads on start, then re-lists on every `schema` change event,
 * so new/changed/deleted schemas apply to the next event without a restart. Invalid entries are
 * skipped and reported via `onError`. If the initial load fails, `ready` rejects (and `onError`
 * is called) but the subscription stays, so the next `schema` change event retries the load.
 */
export function createSchemaRegistry(
  store: Pick<ConfigStore, "list" | "onChange">,
  opts: RegistryOptions = {},
): SchemaRegistry {
  const report = (e: unknown, id?: string) => {
    try {
      opts.onError?.(e instanceof Error ? e : new Error(String(e)), id);
    } catch {
      /* ignore reporter failure */
    }
  };
  let current: Schema[] = [];
  let closed = false;
  let unsub: (() => void) | undefined;
  let chain: Promise<void> = Promise.resolve();

  const reload = async (): Promise<void> => {
    {
      const all = await store.list("schema");
      const ok: Schema[] = [];
      for (const s of all) {
        if (!valid(s)) {
          report(new Error("invalid schema entry"), (s as { id?: string } | null)?.id);
          continue;
        }
        try {
          compileMatch(s);
        } catch (e) {
          report(e, s.id);
          continue;
        }
        ok.push(s);
      }
      if (!closed) current = ok;
    }
  };
  // Later reload failures keep the previous schemas and are reported; the next change retries.
  const queue = () =>
    (chain = chain.then(reload).catch((e) => {
      report(e);
    }));

  const ready = (async () => {
    const u = await store.onChange("schema", () => void queue());
    if (closed) u();
    else unsub = u;
    let failure: unknown;
    let failed = false;
    chain = chain.then(reload).catch((e) => {
      failed = true;
      failure = e;
      report(e);
    });
    await chain;
    if (failed) throw failure;
  })();
  ready.catch(() => {}); // rejection is observable via `ready`; avoid an unhandled-rejection crash

  return {
    ready,
    classify: (parsed) => classifyEvent(parsed, current, (e, id) => report(e, id)),
    schemas: () => [...current],
    close() {
      closed = true;
      unsub?.();
    },
  };
}
