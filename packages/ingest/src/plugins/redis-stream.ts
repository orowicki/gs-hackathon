import { hostname } from "node:os";
import { Redis } from "ioredis";
import type { JsonObject } from "@alerting/shared";
import type { SourcePlugin } from "../types.js";
import { REDIS_STREAM_CONFIG_SCHEMA } from "./schemas.js";

export interface RedisStreamConfig {
  stream: string;
  consumerGroup: string;
}

const TEXT_FIELDS = ["data", "message", "msg", "line"];

/** Convert the flat [k, v, k, v...] field array of a stream entry to a message. */
export function entryToMessage(fields: string[]): string | JsonObject {
  const map: JsonObject = {};
  for (let i = 0; i + 1 < fields.length; i += 2) map[fields[i] as string] = fields[i + 1] as string;
  const keys = Object.keys(map);
  if (keys.length === 1 && TEXT_FIELDS.includes(keys[0] as string)) return map[keys[0] as string] as string;
  return map;
}

type Entries = [string, string[]][];
type ReadReply = [string, Entries][] | null;

export const redisStreamPlugin: SourcePlugin<RedisStreamConfig> = {
  type: "redis_stream",
  configSchema: REDIS_STREAM_CONFIG_SCHEMA,
  async start(config, emit, ctx) {
    const url = ctx.redisUrl ?? process.env.REDIS_URL ?? "redis://localhost:6379";
    const redis = new Redis(url, { maxRetriesPerRequest: null });
    redis.on("error", (e: Error) => ctx.logger?.error(`redis_stream connection: ${e.message}`));
    const consumer = `${hostname()}-${process.pid}`;
    let stopped = false;

    try {
      await redis.xgroup("CREATE", config.stream, config.consumerGroup, "$", "MKSTREAM");
    } catch (e) {
      if (!String(e).includes("BUSYGROUP")) {
        redis.disconnect();
        throw e;
      }
    }

    const read = async (id: string, block: boolean): Promise<Entries> => {
      const args: (string | number)[] = ["GROUP", config.consumerGroup, consumer, "COUNT", 100];
      if (block) args.push("BLOCK", 1000);
      args.push("STREAMS", config.stream, id);
      const reply = (await (redis.xreadgroup as (...a: (string | number)[]) => Promise<unknown>)(...args)) as ReadReply;
      return reply?.[0]?.[1] ?? [];
    };

    const process_ = async (entries: Entries): Promise<void> => {
      for (const [id, fields] of entries) {
        await emit(entryToMessage(fields));
        await redis.xack(config.stream, config.consumerGroup, id);
      }
    };

    const loop = (async () => {
      let pendingDone = false;
      let cursor = "0";
      while (!stopped) {
        try {
          if (!pendingDone) {
            const entries = await read(cursor, false);
            if (entries.length === 0) pendingDone = true;
            else {
              await process_(entries);
              cursor = entries[entries.length - 1]![0];
            }
          } else {
            await process_(await read(">", true));
          }
        } catch (e) {
          if (stopped) return;
          ctx.logger?.error(`redis_stream read failed: ${String(e)}`);
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    })();

    const onAbort = () => void handle.stop();
    ctx.signal?.addEventListener("abort", onAbort, { once: true });
    const handle = {
      async stop() {
        if (stopped) return;
        stopped = true;
        ctx.signal?.removeEventListener("abort", onAbort);
        redis.disconnect(); // unblocks the pending XREADGROUP
        await loop;
      },
    };
    return handle;
  },
};
