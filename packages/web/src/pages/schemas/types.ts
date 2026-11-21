/** Local mirrors of the shared schema types (the web package does not depend on @alerting/shared). */

/** Common fields the schema mapper outputs (see packages/schemas/src/types.ts). */
export const COMMON_FIELDS = [
  {
    name: "severity",
    required: true,
    hint: "info, warning, error or critical (defaults to info)",
  },
  { name: "title", required: true, hint: "Short headline of the alert" },
  { name: "source", required: true, hint: "Which system sent it" },
  { name: "environment", required: true, hint: "For example prod or staging" },
  {
    name: "dedupKey",
    required: true,
    hint: "Events with the same key belong to one alert",
  },
  { name: "sourceStatus", required: true, hint: "firing or resolved" },
  {
    name: "occurredAt",
    required: true,
    hint: "When it happened (ISO time or epoch)",
  },
  { name: "type", required: false, hint: "Kind of event" },
  { name: "message", required: false, hint: "Longer description" },
  { name: "entity", required: false, hint: "The thing affected" },
  { name: "runbookUrl", required: false, hint: "Link to instructions" },
] as const;

export type CommonFieldName = (typeof COMMON_FIELDS)[number]["name"];

export type MappingKind = "path" | "constant" | "template";

interface Base {
  valueMap?: Record<string, string>;
  default?: string;
}
export type FieldMapping =
  | (Base & { kind: "path"; path: string })
  | (Base & { kind: "constant"; value: string })
  | (Base & { kind: "template"; template: string });

/** A filter is stored as text or as a tree; the UI edits text. */
export type Filter = string | Record<string, unknown>;

export interface Schema {
  id: string;
  name: string;
  match: Filter;
  mapping: Partial<Record<CommonFieldName, FieldMapping>>;
}

export type CommonFields = Partial<Record<CommonFieldName, string>>;

export const RESERVED_IDS = ["import", "export", "test", "new"];
