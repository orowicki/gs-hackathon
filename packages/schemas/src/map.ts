import type { FieldMapping } from "@alerting/shared";
import {
  SCHEMA_COMMON_FIELD_NAMES,
  type SchemaCommonFields,
  type SchemaDef,
} from "./types.js";
import {
  normaliseSeverity,
  normaliseStatus,
  normaliseTimestamp,
} from "./normalise.js";

/** Dot path lookup with array indexes (`a.0.b`); own properties only. */
export function getPath(root: unknown, path: string): unknown {
  let cur = root;
  for (const seg of path.split(".")) {
    if (cur === null || typeof cur !== "object" || !Object.hasOwn(cur, seg))
      return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function text(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return v === "" ? undefined : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined; // objects/arrays: omit, no JSON blobs
}

/** Template result; undefined if ANY placeholder is missing/empty (then `default` applies). */
function renderTemplate(tpl: string, parsed: unknown): string | undefined {
  let missing = false;
  const out = tpl.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, p: string) => {
    const t = text(getPath(parsed, p));
    if (t === undefined) {
      missing = true;
      return "";
    }
    return t;
  });
  return missing ? undefined : out;
}

function raw(parsed: unknown, m: FieldMapping): string | undefined {
  switch (m.kind) {
    case "path":
      return text(getPath(parsed, m.path));
    case "constant":
      return text(m.value);
    case "template":
      return renderTemplate(m.template, parsed);
  }
}

function applyValueMap(
  v: string,
  map: Record<string, string> | undefined,
): string {
  if (!map) return v;
  if (Object.hasOwn(map, v)) return map[v]!;
  const lc = v.toLowerCase();
  for (const [k, to] of Object.entries(map))
    if (k.toLowerCase() === lc) return to;
  return v;
}

/**
 * Map a parsed event onto the common fields using `schema.mapping`.
 *
 * Per field: value from `path` / `constant` / `template`; a template with any missing placeholder
 * counts as missing (so `default` applies). Then `valueMap` (exact, then case-insensitive), and
 * `default` if nothing was found. Severity is normalised (case, aliases warn/crit) and falls back
 * to `info`. sourceStatus is normalised (legacy mapping key `status` is an alias) to firing|resolved, unknown values are omitted. occurredAt is
 * normalised to an ISO string (ISO, epoch s or ms); unparseable values are omitted.
 * Fields with no value are omitted (except severity, always present).
 */
export function mapCommonFields(
  parsed: unknown,
  schema: SchemaDef,
): Partial<SchemaCommonFields> {
  const out: Partial<SchemaCommonFields> = {};
  for (const name of SCHEMA_COMMON_FIELD_NAMES) {
    // legacy `status` key is an alias of `sourceStatus` (sourceStatus wins)
    const m =
      name === "sourceStatus"
        ? (schema.mapping.sourceStatus ?? schema.mapping.status)
        : schema.mapping[name];
    let v = m ? raw(parsed, m) : undefined;
    if (m) {
      if (v !== undefined) v = applyValueMap(v, m.valueMap);
      else if (m.default !== undefined && m.default !== "") v = m.default;
    }
    switch (name) {
      case "severity":
        out.severity = normaliseSeverity(v) ?? "info";
        break;
      case "sourceStatus": {
        const s = normaliseStatus(v);
        if (s) out.sourceStatus = s;
        break;
      }
      case "occurredAt": {
        const t = normaliseTimestamp(v);
        if (t) out.occurredAt = t;
        break;
      }
      default:
        if (v !== undefined) out[name] = v;
    }
  }
  return out;
}
