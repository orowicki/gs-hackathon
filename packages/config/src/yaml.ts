import { parse, stringify } from "yaml";
import { entityId } from "./store.js";
import type { ConfigStore, Kind, KindMap } from "./store.js";

export function toYaml(entity: unknown): string {
  return stringify(entity);
}

/** Parse YAML text into a value; throws an Error with a clear message on bad YAML. */
export function fromYaml(text: string): unknown {
  try {
    return parse(text);
  } catch (err) {
    throw new Error(
      `invalid YAML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** YAML text of a stored entity. Throws if it does not exist. */
export async function exportYaml(
  store: ConfigStore,
  kind: Kind,
  id: string,
): Promise<string> {
  const entity = await store.get(kind, id);
  if (entity === undefined) throw new Error(`${kind} not found: ${id}`);
  return toYaml(entity);
}

/** Parse, validate (same rules as upsert) and upsert one entity from YAML text. */
export async function importYaml<K extends Kind>(
  store: ConfigStore,
  kind: K,
  text: string,
): Promise<KindMap[K]> {
  const value = fromYaml(text);
  entityId(kind, value); // validate before touching the store
  const entity = value as KindMap[K];
  await store.upsert(kind, entity);
  return entity;
}
