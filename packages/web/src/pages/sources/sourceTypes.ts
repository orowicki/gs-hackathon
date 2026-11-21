// Config schemas are NOT kept here: they come from GET /api/source-types (see useSourceTypes).
// Types mirror packages/shared/src/types/source.ts (web does not depend on @alerting/shared).

export type SourceType = string;
export type ParserType = string;

export interface ParserConfig {
  type: ParserType;
  pattern?: string;
}

export interface Source {
  id: string;
  name: string;
  enabled: boolean;
  parser: ParserConfig;
  type: SourceType;
  config: Record<string, unknown>;
}

export interface JsonSchemaProperty {
  type?: "string" | "number" | "integer" | "boolean";
  title?: string;
  description?: string;
  enum?: (string | number)[];
  minLength?: number;
}

export interface JsonSchemaObject {
  $schema?: string;
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

/** Optional display labels (UI metadata only); unknown types fall back to the type id. */
const SOURCE_TYPE_LABELS: Record<string, string> = {
  http: "HTTP ingest",
  file_tail: "File tail",
  redis_stream: "Redis stream",
};

export function sourceTypeLabel(type: string): string {
  return SOURCE_TYPE_LABELS[type] ?? type;
}

export interface SourceTypeInfo {
  type: string;
  configSchema: JsonSchemaObject;
}

export interface SourceTypesResponse {
  sourceTypes: SourceTypeInfo[];
  parserConfigSchema: JsonSchemaObject;
}

export const RESERVED_IDS = ["import", "export", "test"];
