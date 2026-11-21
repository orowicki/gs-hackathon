import { PARSER_TYPES } from "@alerting/shared";
import type { JsonSchemaObject } from "../types.js";

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

export const PARSER_CONFIG_SCHEMA: JsonSchemaObject = {
  $schema: DRAFT,
  type: "object",
  properties: {
    type: { type: "string", enum: [...PARSER_TYPES] },
    pattern: {
      type: "string",
      title: "Regex with named groups (regex parser only)",
    },
  },
  required: ["type"],
  additionalProperties: false,
};
