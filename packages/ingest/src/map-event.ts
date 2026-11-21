import type { ConfigStore } from "@alerting/config";
import { createSchemaRegistry, type SchemaRegistry } from "@alerting/schemas";
import type { IngestServiceOptions } from "./runner.js";

type MapEvent = NonNullable<IngestServiceOptions["mapEvent"]>;

/**
 * Event mapper backed by a schema registry: sets schemaId, common fields and the (possibly
 * normalised) parsed payload. A classify failure keeps the event unmapped (the worker also
 * keeps the unmapped event when mapEvent throws; here we log and return it ourselves).
 */
export function createSchemaMapEvent(
  registry: Pick<SchemaRegistry, "classify">,
  opts: { onError?: (err: Error) => void } = {},
): MapEvent {
  return (e) => {
    try {
      const c = registry.classify(e.parsed);
      return {
        ...e,
        parsed: c.parsed as typeof e.parsed,
        schemaId: c.schemaId,
        common: c.common as typeof e.common,
      };
    } catch (err) {
      try {
        opts.onError?.(err instanceof Error ? err : new Error(String(err)));
      } catch {
        /* ignore reporter failure */
      }
      return e;
    }
  };
}

export interface SchemaMapping {
  mapEvent: MapEvent;
  /**
   * Resolves after the first successful schema load, so starting the worker afterwards never maps
   * against an empty registry. A failed load is logged and retried (new registry, 1s doubling to 30s)
   * until it succeeds or `close()` is called (then it resolves too).
   */
  ready: Promise<void>;
  close(): void;
}

/** Live schema registry on a config store plus its mapEvent. Errors are logged, never thrown. */
export function startSchemaMapping(
  store: Pick<ConfigStore, "list" | "onChange">,
  opts: { onError?: (err: Error) => void; logger?: { error(msg: string): void } } = {},
): SchemaMapping {
  const onError =
    opts.onError ?? ((err: Error) => (opts.logger ?? console).error(`schema mapping: ${err.message}`));
  let closed = false;
  let registry: SchemaRegistry = createSchemaRegistry(store, { onError });
  const mapEvent = createSchemaMapEvent({ classify: (p) => registry.classify(p) }, { onError });
  const ready = (async () => {
    let delay = 1000;
    for (;;) {
      try {
        await registry.ready;
        return;
      } catch {
        // already reported through onError by the registry
      }
      registry.close();
      if (closed) return;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 30000);
      if (closed) return;
      registry = createSchemaRegistry(store, { onError });
    }
  })();
  return {
    mapEvent,
    ready,
    close() {
      closed = true;
      registry.close();
    },
  };
}
