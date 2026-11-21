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
  /** Resolves when the initial schema load finished; never rejects (the registry keeps retrying). */
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
  const registry = createSchemaRegistry(store, { onError });
  return {
    mapEvent: createSchemaMapEvent(registry, { onError }),
    ready: registry.ready.catch(() => {
      /* reported via onError; the registry retries */
    }),
    close: () => registry.close(),
  };
}
