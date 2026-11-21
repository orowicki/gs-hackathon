import type { JsonObject, SourceType } from "@alerting/shared";

/** JSON Schema (draft 2020-12) describing an object. */
export type JsonSchemaObject = { type: "object" } & { [key: string]: unknown };

export type Emit = (raw: string | JsonObject, meta?: { receivedAt?: string }) => Promise<void>;

export interface SourceContext {
  sourceId: string;
  logger?: {
    info(msg: string, ...args: unknown[]): void;
    warn(msg: string, ...args: unknown[]): void;
    error(msg: string, ...args: unknown[]): void;
  };
  signal?: AbortSignal;
}

export interface SourceHandle {
  stop(): Promise<void>;
}

export interface SourcePlugin<C = unknown> {
  type: SourceType | string;
  /** JSON Schema (draft 2020-12 object schema) used by the UI to generate the config form. */
  configSchema: JsonSchemaObject;
  start(config: C, emit: Emit, ctx: SourceContext): Promise<SourceHandle>;
}
