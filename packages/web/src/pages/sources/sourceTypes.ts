// Mirrors packages/ingest/src/plugins/schemas.ts (no route serves these schemas).
// Types mirror packages/shared/src/types/source.ts (web does not depend on @alerting/shared).

export type SourceType = "http" | "file_tail" | "redis_stream";
export type ParserType = "json" | "logfmt" | "regex" | "raw";
export const PARSER_TYPES: ParserType[] = ["json", "logfmt", "regex", "raw"];

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

const DRAFT = "https://json-schema.org/draft/2020-12/schema";

export const HTTP_CONFIG_SCHEMA: JsonSchemaObject = {
  $schema: DRAFT,
  type: "object",
  properties: {},
  additionalProperties: false,
};

export const FILE_TAIL_CONFIG_SCHEMA: JsonSchemaObject = {
  $schema: DRAFT,
  type: "object",
  properties: { path: { type: "string", title: "Path or glob", minLength: 1 } },
  required: ["path"],
  additionalProperties: false,
};

export const REDIS_STREAM_CONFIG_SCHEMA: JsonSchemaObject = {
  $schema: DRAFT,
  type: "object",
  properties: {
    stream: { type: "string", title: "Stream key", minLength: 1 },
    consumerGroup: { type: "string", title: "Consumer group", minLength: 1 },
  },
  required: ["stream", "consumerGroup"],
  additionalProperties: false,
};

export const SOURCE_TYPE_SCHEMAS: Record<SourceType, JsonSchemaObject> = {
  http: HTTP_CONFIG_SCHEMA,
  file_tail: FILE_TAIL_CONFIG_SCHEMA,
  redis_stream: REDIS_STREAM_CONFIG_SCHEMA,
};

export const SOURCE_TYPE_LABELS: Record<SourceType, string> = {
  http: "HTTP ingest",
  file_tail: "File tail",
  redis_stream: "Redis stream",
};

export const RESERVED_IDS = ["import", "export", "test"];
