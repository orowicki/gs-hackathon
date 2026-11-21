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

export const KAFKA_CONFIG_SCHEMA: JsonSchemaObject = {
  $schema: DRAFT,
  type: "object",
  properties: {
    brokers: {
      type: "string",
      title: "Brokers",
      description:
        "Comma-separated bootstrap brokers as host:port, e.g. redpanda:9092 or kafka-1:9092,kafka-2:9092.",
      minLength: 1,
    },
    topic: {
      type: "string",
      title: "Topic",
      description: "Topic to consume. Each message value is one raw event.",
      minLength: 1,
    },
    groupId: {
      type: "string",
      title: "Consumer group",
      description:
        "Consumer group id. Instances with the same group share the topic's partitions; offsets are committed after an event is accepted.",
      minLength: 1,
      default: "alerting",
    },
    fromBeginning: {
      type: "boolean",
      title: "Start from the beginning",
      description:
        "When the group has no committed offset yet, read the topic from its start instead of only new messages.",
      default: false,
    },
  },
  required: ["brokers", "topic", "groupId"],
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
