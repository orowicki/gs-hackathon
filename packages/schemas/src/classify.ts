import { evaluate, tryParse, validateTree, type FilterNode } from "@alerting/filter";
import type { CommonFields, Schema } from "@alerting/shared";
import { mapCommonFields } from "./map.js";
import { normaliseDeep } from "./normalise.js";

export type SchemaErrorHandler = (err: Error, schemaId: string) => void;

/** Compile a schema's match filter (text or tree). Throws on a bad filter. */
export function compileMatch(schema: Schema): FilterNode | null {
  const m = schema.match as unknown;
  if (typeof m === "string") {
    const r = tryParse(m);
    if (!r.ok) throw new Error(`invalid match filter: ${r.error.message}`);
    return r.tree;
  }
  return validateTree(m);
}

/**
 * First matching schema. Order: schemas sorted by `id` ascending (plain string compare), so users
 * control precedence with id prefixes (`10-foo`, `20-bar`). A schema whose filter cannot be parsed
 * is skipped and reported via `onError`. An empty filter matches everything.
 */
export function matchSchema(parsed: unknown, schemas: readonly Schema[], onError?: SchemaErrorHandler): Schema | undefined {
  const sorted = [...schemas].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const s of sorted) {
    let tree: FilterNode | null;
    try {
      tree = compileMatch(s);
    } catch (e) {
      onError?.(e instanceof Error ? e : new Error(String(e)), s.id);
      continue;
    }
    if (evaluate(tree, { event: parsed })) return s;
  }
  return undefined;
}

export interface Classification {
  schemaId: string | null;
  common: Partial<CommonFields>;
  /** The event with canonical numeric strings converted to numbers; store this one. */
  parsed: unknown;
}

/**
 * Normalise (`normaliseDeep`), match and map. Match filters and mapping run on the normalised
 * event. Unmatched: `{ schemaId: null, common: {}, parsed }` (raw fields stay usable by filters).
 */
export function classifyEvent(raw: unknown, schemas: readonly Schema[], onError?: SchemaErrorHandler): Classification {
  const parsed = normaliseDeep(raw);
  const s = matchSchema(parsed, schemas, onError);
  if (!s) return { schemaId: null, common: {}, parsed };
  return { schemaId: s.id, common: mapCommonFields(parsed, s), parsed };
}
