import { createHash } from "node:crypto";
import { hostname } from "node:os";
import type { Redis } from "ioredis";
import type { Pool } from "pg";
import {
  GROUP_PARSE,
  LIST_RECENT_EVENTS,
  STREAM_EVENTS,
  STREAM_RAW_EVENTS,
  type Event,
  type ParserConfig,
  type RawMessage,
} from "@alerting/shared";
import { parse } from "./parsers/index.js";
import { insertEvents } from "./event-store.js";

export const RAW_PARSER: ParserConfig = { type: "raw" };
const EVENTS_MAXLEN = 1_000_000;
const RECENT_MAX = 1000;

export interface Logger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}
export const consoleLogger: Logger = {
  info: (m, ...a) => console.log(m, ...a),
  warn: (m, ...a) => console.warn(m, ...a),
  error: (m, ...a) => console.error(m, ...a),
};

/** Deterministic UUID-shaped id from the stream entry id, so redelivery never duplicates an event. */
export function eventIdFor(entryId: string): string {
  const h = createHash("sha256").update(entryId).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Decode the `data` field of a raw stream entry; undefined when malformed. */
export function decodeRawEntry(fields: string[]): RawMessage | undefined {
  const i = fields.indexOf("data");
  if (i < 0 || i % 2 !== 0) return undefined;
  try {
    const v = JSON.parse(fields[i + 1] ?? "") as Partial<RawMessage> | null;
    if (!v || typeof v.sourceId !== "string" || typeof v.raw !== "string") return undefined;
    const receivedAt =
      typeof v.receivedAt === "string" && !Number.isNaN(Date.parse(v.receivedAt))
        ? v.receivedAt
        : new Date().toISOString();
    return { sourceId: v.sourceId, receivedAt, raw: v.raw };
  } catch {
    return undefined;
  }
}

/** Pure: RawMessage + parser config -> Event (no schema yet). */
export function buildEvent(entryId: string, msg: RawMessage, parser: ParserConfig): Event {
  return {
    id: eventIdFor(entryId),
    sourceId: msg.sourceId,
    receivedAt: msg.receivedAt,
    raw: msg.raw,
    parsed: parse(msg.raw, parser),
    schemaId: null,
    common: {},
  };
}

export interface WorkerOptions {
  redis: Redis;
  pool: Pool;
  /** Parser for a source; unknown source -> undefined (raw parser is used). */
  getParser: (sourceId: string) => ParserConfig | undefined | Promise<ParserConfig | undefined>;
  /** Hook for schema mapping (#12). Errors keep the unmapped event. */
  mapEvent?: (e: Event) => Event | Promise<Event>;
  stream?: string;
  group?: string;
  consumer?: string;
  count?: number;
  blockMs?: number;
  logger?: Logger;
}

export interface ParseWorker {
  stop(): Promise<void>;
}

type Entry = [string, string[]];
type ReadResult = [string, Entry[]][] | null;

export function startParseWorker(opts: WorkerOptions): ParseWorker {
  const stream = opts.stream ?? STREAM_RAW_EVENTS;
  const group = opts.group ?? GROUP_PARSE;
  const consumer = opts.consumer ?? process.env.WORKER_CONSUMER ?? `parse-${hostname()}`;
  const count = opts.count ?? 200;
  const blockMs = opts.blockMs ?? 1000;
  const log = opts.logger ?? consoleLogger;
  const cmd = opts.redis;
  const blocker = cmd.duplicate();
  blocker.on("error", () => undefined);
  let stopping = false;

  async function processBatch(entries: Entry[]): Promise<void> {
    const events: Event[] = [];
    const ids: string[] = [];
    for (const [entryId, fields] of entries) {
      ids.push(entryId);
      const msg = decodeRawEntry(fields);
      if (!msg) {
        log.warn(`parse worker: malformed entry ${entryId}, dropping`);
        continue;
      }
      try {
        const parser = (await opts.getParser(msg.sourceId)) ?? RAW_PARSER;
        let ev = buildEvent(entryId, msg, parser);
        if (opts.mapEvent) {
          try {
            ev = await opts.mapEvent(ev);
          } catch (err) {
            log.error(`parse worker: mapEvent failed for ${ev.id}: ${String(err)}`);
          }
        }
        events.push(ev);
      } catch (err) {
        log.error(`parse worker: entry ${entryId} failed, dropping: ${String(err)}`);
      }
    }
    // Throws on DB/redis failure: entries stay pending and are retried by the caller.
    await insertEvents(opts.pool, events);
    const p = cmd.multi();
    for (const ev of events) {
      const json = JSON.stringify(ev);
      p.xadd(STREAM_EVENTS, "MAXLEN", "~", EVENTS_MAXLEN, "*", "data", json);
      p.lpush(LIST_RECENT_EVENTS, json);
    }
    if (events.length > 0) p.ltrim(LIST_RECENT_EVENTS, 0, RECENT_MAX - 1);
    p.xack(stream, group, ...ids);
    const res = await p.exec();
    for (const [err] of res ?? []) if (err) throw err;
  }

  async function read(id: string, block: boolean): Promise<Entry[]> {
    const args: (string | number)[] = ["GROUP", group, consumer, "COUNT", count];
    if (block) args.push("BLOCK", blockMs);
    args.push("STREAMS", stream, id);
    const res = (await (blocker as unknown as { xreadgroup: (...a: unknown[]) => Promise<ReadResult> }).xreadgroup(
      ...args,
    )) as ReadResult;
    return (res?.[0]?.[1] ?? []).map(([eid, f]): Entry => [eid, f ?? []]);
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function run(): Promise<void> {
    while (!stopping) {
      try {
        await cmd.xgroup("CREATE", stream, group, "0", "MKSTREAM").catch((err: unknown) => {
          if (!String(err).includes("BUSYGROUP")) throw err;
        });
        // Recover own pending entries first, then take over entries abandoned by dead consumers.
        for (let entries = await read("0", false); entries.length > 0 && !stopping; entries = await read("0", false)) {
          await processBatch(entries);
        }
        await claimAbandoned();
        while (!stopping) {
          const entries = await read(">", true);
          if (entries.length > 0) await processBatch(entries);
        }
      } catch (err) {
        if (stopping) return;
        log.error(`parse worker: ${String(err)}; retrying in 1s`);
        await sleep(1000);
      }
    }
  }

  async function claimAbandoned(): Promise<void> {
    try {
      const res = (await cmd.call("XAUTOCLAIM", stream, group, consumer, 30000, "0", "COUNT", count)) as [
        string,
        Entry[],
      ];
      const claimed = (res[1] ?? []).map(([eid, f]): Entry => [eid, f ?? []]);
      if (claimed.length > 0) await processBatch(claimed);
    } catch (err) {
      log.warn(`parse worker: xautoclaim skipped: ${String(err)}`);
    }
  }

  const done = run();
  return {
    async stop() {
      stopping = true;
      blocker.disconnect();
      await done.catch(() => undefined);
    },
  };
}
