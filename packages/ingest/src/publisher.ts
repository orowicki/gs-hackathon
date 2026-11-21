import type { Redis } from "ioredis";
import { STREAM_RAW_EVENTS, type RawMessage } from "@alerting/shared";
import type { Emit } from "./types.js";

/** Approximate cap of the raw stream (XADD MAXLEN ~). */
export const RAW_STREAM_MAXLEN = 1_000_000;

export interface RawPublisher {
  /** Emit function for one source: every call appends one RawMessage to STREAM_RAW_EVENTS. */
  forSource(sourceId: string): Emit;
}

export function toRawMessage(
  sourceId: string,
  raw: Parameters<Emit>[0],
  receivedAt: string = new Date().toISOString(),
): RawMessage {
  return { sourceId, receivedAt, raw: typeof raw === "string" ? raw : JSON.stringify(raw) };
}

export function createRawPublisher(redis: Redis): RawPublisher {
  return {
    forSource(sourceId) {
      return async (raw, meta) => {
        const msg = toRawMessage(sourceId, raw, meta?.receivedAt);
        await redis.xadd(STREAM_RAW_EVENTS, "MAXLEN", "~", RAW_STREAM_MAXLEN, "*", "data", JSON.stringify(msg));
      };
    },
  };
}
