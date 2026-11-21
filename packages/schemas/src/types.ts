import type { FieldMapping, Schema } from "@alerting/shared";

/** Common fields as defined by the SPEC (local: shared still has `status` and lacks the optional four). */
export interface SchemaCommonFields {
  severity: "info" | "warning" | "error" | "critical";
  title: string;
  source: string;
  environment: string;
  dedupKey: string;
  /** firing | resolved, as reported by the source. */
  sourceStatus: "firing" | "resolved";
  /** ISO timestamp. */
  occurredAt: string;
  type?: string;
  message?: string;
  entity?: string;
  runbookUrl?: string;
}

export type SchemaCommonFieldName = keyof SchemaCommonFields;

export const SCHEMA_COMMON_FIELD_NAMES = [
  "severity",
  "title",
  "source",
  "environment",
  "dedupKey",
  "sourceStatus",
  "occurredAt",
  "type",
  "message",
  "entity",
  "runbookUrl",
] as const satisfies readonly SchemaCommonFieldName[];

/** Schema whose mapping is keyed by the SPEC common fields; legacy `status` is accepted as alias of `sourceStatus`. */
export type SchemaDef = Omit<Schema, "mapping"> & {
  mapping: Partial<Record<SchemaCommonFieldName | "status", FieldMapping>>;
};
