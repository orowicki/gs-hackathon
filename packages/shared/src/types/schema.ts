import type { CommonFieldName, Id } from "./common.js";
import type { Filter } from "./filter.js";

interface FieldMappingBase {
  /** Optional value map, e.g. { ERROR: "error" }. */
  valueMap?: Record<string, string>;
  /** Used when the path/template yields nothing. */
  default?: string;
}
export type FieldMapping =
  | (FieldMappingBase & { kind: "path"; path: string })
  | (FieldMappingBase & { kind: "constant"; value: string })
  | (FieldMappingBase & { kind: "template"; template: string });

/** Event type: how to recognise an event and map it onto the common fields. */
export interface Schema {
  id: Id;
  name: string;
  /** Filter on the parsed event. */
  match: Filter;
  /** Unmapped fields fall back to defaults (severity=info). */
  mapping: Partial<Record<CommonFieldName, FieldMapping>>;
}
