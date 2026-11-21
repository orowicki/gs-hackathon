import type { ConfigStore } from "@alerting/config";
import type { SchemaDef } from "./types.js";
import {
  classifyCompiled,
  compileSchemas,
  type CompiledSchema,
  type Classification,
} from "./classify.js";

export interface SchemaRegistry {
  ready: Promise<void>;
  classify(parsed: unknown): Classification;
  schemas(): SchemaDef[];
  close(): void;
}

export interface RegistryOptions {
  onError?: (err: Error, schemaId?: string) => void;
}

function valid(s: unknown): s is SchemaDef {
  if (typeof s !== "object" || s === null) return false;
  const e = s as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    typeof e.mapping === "object" &&
    e.mapping !== null &&
    e.match !== undefined
  );
}

/**
 * Live view of the stored schemas. Loads on start, then re-lists on every `schema` change event,
 * so new/changed/deleted schemas apply to the next event without a restart. Invalid entries are
 * skipped and reported via `onError`. If the initial load fails, `ready` rejects (and `onError`
 * is called) but the subscription stays; the load is retried with backoff (1s doubling to 30s,
 * stopped by `close()`) and on every `schema` change event.
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
  let current: SchemaDef[] = [];
  let compiled: CompiledSchema[] = [];
  let closed = false;
  let unsub: (() => void) | undefined;
  let chain: Promise<void> = Promise.resolve();
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let backoff = 1000;

  const reload = async (): Promise<void> => {
    {
      const all = await store.list("schema");
      const ok: SchemaDef[] = [];
      for (const s of all) {
        if (!valid(s)) {
          report(
            new Error("invalid schema entry"),
            (s as { id?: string } | null)?.id,
          );
          continue;
        }
        ok.push(s);
      }
      const c = compileSchemas(ok, report);
      if (!closed) {
        compiled = c;
        current = c.map((x) => x.schema);
      }
    }
  };
  // Later reload failures keep the previous schemas and are reported; the next change retries.
  const queue = () =>
    (chain = chain.then(reload).catch((e) => {
      report(e);
    }));

  // Initial load failed: retry with backoff (1s doubling to 30s) until success or close().
  const scheduleRetry = () => {
    if (closed || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      if (closed) return;
      backoff = Math.min(backoff * 2, 30000);
      void (chain = chain
        .then(reload)
        .then(() => {
          backoff = 1000;
        })
        .catch((e) => {
          report(e);
          scheduleRetry();
        }));
    }, backoff);
    // note: backoff doubles when the timer fires
  };

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
      scheduleRetry();
    });
    await chain;
    if (failed) throw failure;
  })();
  ready.catch(() => {}); // rejection is observable via `ready`; avoid an unhandled-rejection crash

  return {
    ready,
    classify: (parsed) => classifyCompiled(parsed, compiled),
    schemas: () => [...current],
    close() {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      unsub?.();
    },
  };
}
