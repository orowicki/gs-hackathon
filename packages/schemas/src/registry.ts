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
 * skipped and reported via `onError`.
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

  const reload = async () => {
    try {
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
    } catch (e) {
      report(e);
    }
  };
  const queue = () => (chain = chain.then(reload));

  const ready = (async () => {
    const u = await store.onChange("schema", () => void queue());
    if (closed) u();
    else unsub = u;
    await queue();
  })();

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
