import type { Id } from "./common.js";

export const PARSER_TYPES = ["json", "logfmt", "regex", "raw"] as const;
export type ParserType = (typeof PARSER_TYPES)[number];

export interface ParserConfig {
  type: ParserType;
  /** For `regex`: pattern with named groups. */
  pattern?: string;
}

/** `POST /ingest/{sourceId}` accepts one JSON object, a JSON array or NDJSON; no config. */
export type HttpSourceConfig = Record<string, never>;
export interface FileTailSourceConfig {
  /** Path or glob. */
  path: string;
}
export interface RedisStreamSourceConfig {
  stream: string;
  consumerGroup: string;
}
export interface KafkaSourceConfig {
  /** Comma-separated bootstrap brokers as host:port. */
  brokers: string;
  topic: string;
  groupId: string;
  /** Read from the topic start when the group has no committed offset. Default false. */
  fromBeginning?: boolean;
}

interface SourceBase {
  id: Id;
  name: string;
  enabled: boolean;
  parser: ParserConfig;
}
export type Source =
  | (SourceBase & { type: "http"; config: HttpSourceConfig })
  | (SourceBase & { type: "file_tail"; config: FileTailSourceConfig })
  | (SourceBase & { type: "redis_stream"; config: RedisStreamSourceConfig })
  | (SourceBase & { type: "kafka"; config: KafkaSourceConfig });

export type SourceType = Source["type"];
export const SOURCE_TYPES: readonly SourceType[] = ["http", "file_tail", "redis_stream", "kafka"];
