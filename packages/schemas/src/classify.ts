import {
  evaluate,
  tryParse,
  validateTree,
  type FilterNode,
} from "@alerting/filter";
import type { SchemaCommonFields, SchemaDef } from "./types.js";
import { mapCommonFields } from "./map.js";
import { normaliseDeep } from "./normalise.js";

export type SchemaErrorHandler = (err: Error, schemaId: string) => void;

/** Compile a schema's match filter (text or tree). Throws on a bad filter. */
export function compileMatch(schema: SchemaDef): FilterNode | null {
  const m = schema.match as unknown;
  if (typeof m === "string") {
    const r = tryParse(m);
    if (!r.ok) throw new Error(`invalid match filter: ${r.error.message}`);
    return r.tree;
  }
  return validateTree(m);
}

export interface CompiledSchema {
  schema: SchemaDef;
  tree: FilterNode | null;
}

/** Sort by id ascending and compile match filters; bad filters are reported and skipped. */
export function compileSchemas(
  schemas: readonly SchemaDef[],
  onError?: SchemaErrorHandler,
): CompiledSchema[] {
  const sorted = [...schemas].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const out: CompiledSchema[] = [];
  for (const schema of sorted) {
    try {
      out.push({ schema, tree: compileMatch(schema) });
    } catch (e) {
      onError?.(e instanceof Error ? e : new Error(String(e)), schema.id);
    }
  }
  return out;
}

function matchCompiled(
  parsed: unknown,
  compiled: readonly CompiledSchema[],
): SchemaDef | undefined {
  for (const c of compiled)
    if (evaluate(c.tree, { event: parsed })) return c.schema;
  return undefined;
}

/**
 * First matching schema. Order: schemas sorted by `id` ascending (plain string compare), so users
 * control precedence with id prefixes (`10-foo`, `20-bar`). A schema whose filter cannot be parsed
 * is skipped and reported via `onError`. An empty filter matches everything.
 */
export function matchSchema(
  parsed: unknown,
  schemas: readonly SchemaDef[],
  onError?: SchemaErrorHandler,
): SchemaDef | undefined {
  return matchCompiled(parsed, compileSchemas(schemas, onError));
}

export interface Classification {
  schemaId: string | null;
  common: Partial<SchemaCommonFields>;
  /** The event with canonical numeric strings converted to numbers; store this one. */
  parsed: unknown;
}

/** Classify against pre-compiled (sorted) schemas. */
export function classifyCompiled(
  raw: unknown,
  compiled: readonly CompiledSchema[],
): Classification {
  const parsed = normaliseDeep(raw);
  const s = matchCompiled(parsed, compiled);
  if (!s) return { schemaId: null, common: {}, parsed };
  // map from the original event so text fields stay verbatim ("1.10" is not "1.1")
  return { schemaId: s.id, common: mapCommonFields(raw, s), parsed };
}

/**
 * Normalise (`normaliseDeep`), match and map. Match filters run on the normalised event; common
 * fields are mapped from the original event (strings verbatim). Unmatched:
 * `{ schemaId: null, common: {}, parsed }` (raw fields stay usable by filters).
 */
export function classifyEvent(
  raw: unknown,
  schemas: readonly SchemaDef[],
  onError?: SchemaErrorHandler,
): Classification {
  return classifyCompiled(raw, compileSchemas(schemas, onError));
}
