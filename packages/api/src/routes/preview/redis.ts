import type { ConfigStore } from "@alerting/config";
import { STREAM_RAW_EVENTS, type RawMessage, type Source } from "@alerting/shared";
import { decodeRawEntry } from "@alerting/ingest";
import type { Redis } from "ioredis";
import type { PreviewDeps } from "./types.js";

export interface RedisPreviewOptions {
  /** Command connection; each client gets its own `duplicate()` for the blocking read. */
  redis: Pick<Redis, "duplicate">;
  config: Pick<ConfigStore, "get">;
  /** Stream to tail (default STREAM_RAW_EVENTS; tests isolate it). */
  stream?: string;
  blockMs?: number;
}

type ReadResult = [string, [string, string[]][]][] | null;

export function createRedisPreview(opts: RedisPreviewOptions): PreviewDeps {
  const stream = opts.stream ?? STREAM_RAW_EVENTS;
  const blockMs = opts.blockMs ?? 5000;
  return {
    async getSource(id: string): Promise<Source | null> {
      return (await opts.config.get("source", id)) ?? null;
    },
    async tail(sourceId: string, onMessage: (m: RawMessage) => void, signal: AbortSignal): Promise<void> {
      if (signal.aborted) return;
      const conn = opts.redis.duplicate();
      conn.on("error", () => undefined);
      // Closing the connection also ends a blocked XREAD at once (QUIT would queue behind it).
      const close = (): void => conn.disconnect();
      signal.addEventListener("abort", close, { once: true });
      try {
        // Resolve "$" to a concrete id once so nothing is missed between two reads.
        const last = (await conn.xrevrange(stream, "+", "-", "COUNT", 1)) as [string, string[]][];
        let lastId = last[0]?.[0] ?? "0-0";
        while (!signal.aborted) {
          const res = (await conn.xread("COUNT", 100, "BLOCK", blockMs, "STREAMS", stream, lastId)) as ReadResult;
          for (const [, entries] of res ?? []) {
            for (const [entryId, fields] of entries) {
              lastId = entryId;
              const msg = decodeRawEntry(fields);
              if (msg && msg.sourceId === sourceId && !signal.aborted) onMessage(msg);
            }
          }
        }
      } catch (err) {
        if (!signal.aborted) throw err;
      } finally {
        signal.removeEventListener("abort", close);
        close();
      }
    },
  };
}
