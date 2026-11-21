import type { Redis } from "ioredis";
import { PREFIX, SEVERITY_ORDER, digestKey, throttleKey, type Notification, type Severity } from "@alerting/shared";
import { deterministicId } from "../ids.js";

export const DEFAULT_THROTTLE_MAX = 5;
export const DEFAULT_THROTTLE_WINDOW_MIN = 10;
/** Sorted set of digests to send. Score = epoch ms due, member = JSON [recipientId, channel]. */
export const ZSET_DIGEST_DUE = `${PREFIX}digestdue`;

export interface ThrottleConfig {
  max: number;
  windowMs: number;
}

function positive(v: string | undefined, dflt: number): number {
  const n = Number(v);
  return v !== undefined && v.trim() !== "" && Number.isFinite(n) && n > 0 ? n : dflt;
}

/** ENGINE_THROTTLE_MAX (default 5) and ENGINE_THROTTLE_WINDOW_MIN (default 10); bad values fall back. */
export function throttleConfigFromEnv(env: Record<string, string | undefined> = process.env): ThrottleConfig {
  return {
    max: Math.floor(positive(env.ENGINE_THROTTLE_MAX, DEFAULT_THROTTLE_MAX)),
    windowMs: Math.round(positive(env.ENGINE_THROTTLE_WINDOW_MIN, DEFAULT_THROTTLE_WINDOW_MIN) * 60_000),
  };
}

export interface ThrottleOptions {
  redis: Redis;
  max: number;
  windowMs: number;
  /** Sends the digest notification (normally the delivery queue). */
  enqueue(n: Notification): Promise<unknown> | unknown;
  now?: () => number;
  /** Timer period of start() (ms, default 1000). */
  tickMs?: number;
  logger?: Pick<Console, "error">;
}

export interface Throttle {
  /** The notification to send now, or null when it was buffered into the digest. `ui` always passes. */
  beforeEnqueue(n: Notification): Promise<Notification | null>;
  /** Sends every digest whose window has ended; returns how many were sent. */
  flushDue(nowMs?: number): Promise<number>;
  start(): void;
  stop(): Promise<void>;
}

// KEYS: counter, buffer, due zset. ARGV: max, windowMs, now, member, notification json.
// Fixed window: first hit starts the window (PEXPIRE); over the limit -> buffer + schedule digest.
const THROTTLE = `
local c = redis.call('incr', KEYS[1])
if c == 1 then redis.call('pexpire', KEYS[1], ARGV[2]) end
if c <= tonumber(ARGV[1]) then return 0 end
redis.call('rpush', KEYS[2], ARGV[5])
local ttl = redis.call('pttl', KEYS[1])
if ttl < 0 then ttl = tonumber(ARGV[2]) redis.call('pexpire', KEYS[1], ttl) end
redis.call('zadd', KEYS[3], 'NX', tonumber(ARGV[3]) + ttl, ARGV[4])
return 1`;
const DRAIN = `local l = redis.call('lrange', KEYS[1], 0, -1) redis.call('del', KEYS[1]) return l`;

export function buildDigest(items: Notification[], recipientId: string, channel: string, at: Date): Notification {
  const alertIds = [...new Set(items.map((i) => i.alertId))];
  let severity: Severity = items[0]!.severity;
  for (const i of items) if (SEVERITY_ORDER[i.severity] > SEVERITY_ORDER[severity]) severity = i.severity;
  const n = alertIds.length;
  const first = items[0]!;
  const titles = items.slice(0, 10).map((i) => `- ${i.title}`);
  if (items.length > 10) titles.push(`... and ${items.length - 10} more`);
  return {
    id: deterministicId("digest", recipientId, channel, ...items.map((i) => i.id)),
    alertId: first.alertId,
    recipientId,
    channel,
    severity,
    title: `${n} more alert${n === 1 ? "" : "s"}`,
    body: titles.join("\n"),
    clickUrl: first.clickUrl.replace(/\/alerts\/[^/]*$/, "/alerts"),
    digestAlertIds: alertIds,
    attempt: 0,
    createdAt: at.toISOString(),
  };
}

export function createThrottle(opts: ThrottleOptions): Throttle {
  const { redis } = opts;
  const now = opts.now ?? Date.now;
  const logger = opts.logger ?? console;
  let timer: NodeJS.Timeout | undefined;
  let flushing: Promise<unknown> = Promise.resolve();

  async function beforeEnqueue(n: Notification): Promise<Notification | null> {
    if (n.channel === "ui") return n;
    const buffered = await redis.eval(
      THROTTLE,
      3,
      throttleKey(n.recipientId, n.channel),
      digestKey(n.recipientId, n.channel),
      ZSET_DIGEST_DUE,
      opts.max,
      opts.windowMs,
      now(),
      JSON.stringify([n.recipientId, n.channel]),
      JSON.stringify(n),
    );
    return Number(buffered) === 1 ? null : n;
  }

  async function flushDue(nowMs: number = now()): Promise<number> {
    const due = await redis.zrangebyscore(ZSET_DIGEST_DUE, "-inf", nowMs);
    let sent = 0;
    for (const member of due) {
      // only the instance whose ZREM succeeds sends this digest
      if ((await redis.zrem(ZSET_DIGEST_DUE, member)) !== 1) continue;
      const [recipientId, channel] = JSON.parse(member) as [string, string];
      const bk = digestKey(recipientId, channel);
      const raw = (await redis.eval(DRAIN, 1, bk)) as string[];
      if (raw.length === 0) continue;
      const items = raw.map((r) => JSON.parse(r) as Notification);
      try {
        await opts.enqueue(buildDigest(items, recipientId, channel, new Date(nowMs)));
        sent++;
      } catch (err) {
        logger.error(`throttle: digest for ${recipientId}/${channel} failed, will retry: ${(err as Error).message}`);
        await redis.lpush(bk, ...raw.slice().reverse());
        await redis.zadd(ZSET_DIGEST_DUE, nowMs + 1000, member);
      }
    }
    return sent;
  }

  return {
    beforeEnqueue,
    flushDue,
    start() {
      if (timer) return;
      timer = setInterval(() => {
        flushing = flushing.then(() => flushDue()).catch((err) => logger.error(`throttle: flush failed: ${(err as Error).message}`));
      }, opts.tickMs ?? 1000);
      timer.unref();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await flushing;
    },
  };
}
