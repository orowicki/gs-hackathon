import type { JsonObject } from "@alerting/shared";
import type { Emit, SourcePlugin } from "../types.js";
import { HTTP_CONFIG_SCHEMA } from "./schemas.js";

const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

function lines(body: string): string[] {
  return body
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.trim() !== "");
}

/**
 * Split an HTTP request body into messages. Accepts one JSON object, a JSON array,
 * NDJSON, or plain text lines. Objects become objects, everything else text.
 * `contentType` is accepted for future use; detection is content-based.
 */
export function splitHttpBody(body: string, contentType?: string): (string | JsonObject)[] {
  void contentType;
  if (body.trim() === "") return [];
  try {
    const v: unknown = JSON.parse(body);
    if (Array.isArray(v)) return v.map((e) => (isObject(e) ? e : JSON.stringify(e)));
    if (isObject(v)) return [v];
  } catch {
    // not a single JSON document; fall through to line mode
  }
  return lines(body).map((l) => {
    try {
      const v: unknown = JSON.parse(l);
      if (isObject(v)) return v;
    } catch {
      // plain text line
    }
    return l;
  });
}

const registry = new Map<string, Emit>();

export const HttpIngestRegistry = {
  register(sourceId: string, emit: Emit): void {
    registry.set(sourceId, emit);
  },
  unregister(sourceId: string): void {
    registry.delete(sourceId);
  },
  get(sourceId: string): Emit | undefined {
    return registry.get(sourceId);
  },
  has(sourceId: string): boolean {
    return registry.has(sourceId);
  },
};

/** Called by the API route for POST /ingest/:sourceId. Framework-agnostic. */
export async function handleHttpIngest(
  sourceId: string,
  body: string,
  contentType?: string,
): Promise<{ accepted: number } | { error: "unknown_source" | "empty" }> {
  const emit = registry.get(sourceId);
  if (!emit) return { error: "unknown_source" };
  const messages = splitHttpBody(body, contentType);
  if (messages.length === 0) return { error: "empty" };
  const receivedAt = new Date().toISOString();
  for (const m of messages) await emit(m, { receivedAt });
  return { accepted: messages.length };
}

export const httpPlugin: SourcePlugin<Record<string, never>> = {
  type: "http",
  configSchema: HTTP_CONFIG_SCHEMA,
  async start(_config, emit, ctx) {
    HttpIngestRegistry.register(ctx.sourceId, emit);
    return {
      stop: async () => {
        if (registry.get(ctx.sourceId) === emit) HttpIngestRegistry.unregister(ctx.sourceId);
      },
    };
  },
};
