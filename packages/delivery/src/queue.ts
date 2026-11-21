import type { Redis } from "ioredis";
import {
  CHANNEL_UI_PUSH,
  LIST_DEAD_LETTERS,
  QUEUE_DELIVERY,
  QUEUE_DELIVERY_PROCESSING,
  ZSET_DELIVERY_RETRY,
  type ChannelStatus,
  type DeadLetter,
  type DeliveryResult,
  type Notification,
} from "@alerting/shared";
import { defaultRegistry, type ChannelRegistry, type QueuedNotification } from "./channel.js";

export interface BackoffOptions {
  baseMs?: number;
  capMs?: number;
  /** 0..1 fraction of random reduction (0 = none). */
  jitter?: number;
}

/** Delay before the next try after `attempt` failed attempts (attempt >= 1): base * 2^(attempt-1), capped. */
export function backoffMs(attempt: number, o: BackoffOptions = {}, random: () => number = Math.random): number {
  const base = o.baseMs ?? 1000;
  const cap = o.capMs ?? 60_000;
  const raw = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  const j = o.jitter ?? 0;
  return Math.round(j > 0 ? raw * (1 - j * random()) : raw);
}

export interface DeliveryQueueOptions extends BackoffOptions {
  registry?: ChannelRegistry;
  maxAttempts?: number;
  concurrency?: number;
  /** Poll interval when idle (ms). */
  pollMs?: number;
  now?: () => number;
}

export interface DeliveryQueue {
  enqueue(n: QueuedNotification): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  listDeadLetters(): Promise<DeadLetter[]>;
  retryDeadLetter(id: string): Promise<Notification | null>;
  channelStatus(): Promise<ChannelStatus[]>;
  /** Move due retries back to the queue; returns count moved. */
  moveDueRetries(): Promise<number>;
}

export function createDeliveryQueue(redis: Redis, opts: DeliveryQueueOptions = {}): DeliveryQueue {
  const registry = opts.registry ?? defaultRegistry;
  const maxAttempts = opts.maxAttempts ?? 5;
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 1, 4));
  const pollMs = opts.pollMs ?? 50;
  const now = opts.now ?? Date.now;
  const lastResult = new Map<string, { healthy: boolean; lastError?: string }>();
  let running = false;
  let loops: Promise<void>[] = [];

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  async function enqueue(n: QueuedNotification): Promise<void> {
    await redis.lpush(QUEUE_DELIVERY, JSON.stringify(n));
  }

  async function moveDueRetries(): Promise<number> {
    const due = await redis.zrangebyscore(ZSET_DELIVERY_RETRY, "-inf", now());
    let moved = 0;
    for (const member of due) {
      // Only the instance whose ZREM succeeds pushes, so a member is never moved twice.
      if ((await redis.zrem(ZSET_DELIVERY_RETRY, member)) === 1) {
        await redis.lpush(QUEUE_DELIVERY, member);
        moved++;
      }
    }
    return moved;
  }

  async function recover(): Promise<void> {
    // Assumes no other live worker shares the processing list (single worker process).
    while ((await redis.rpoplpush(QUEUE_DELIVERY_PROCESSING, QUEUE_DELIVERY)) !== null) {
      /* keep moving */
    }
  }

  async function deadLetter(n: Notification, error: string): Promise<void> {
    const dl: DeadLetter = { id: n.id, notification: n, error, failedAt: new Date(now()).toISOString() };
    await redis.lpush(LIST_DEAD_LETTERS, JSON.stringify(dl));
    const count = await redis.llen(LIST_DEAD_LETTERS);
    await redis.publish(CHANNEL_UI_PUSH, JSON.stringify({ type: "dead_letter", count }));
  }

  async function handle(raw: string): Promise<void> {
    let n: QueuedNotification;
    try {
      n = JSON.parse(raw) as QueuedNotification;
    } catch {
      await redis.lrem(QUEUE_DELIVERY_PROCESSING, 1, raw);
      return;
    }
    const result: DeliveryResult = await registry.send(n);
    const attempt = (n.attempt ?? 0) + 1;
    if (result.status === "delivered") {
      lastResult.set(n.channel, { healthy: true });
    } else {
      lastResult.set(n.channel, { healthy: false, lastError: result.error });
      if (result.retryable && attempt < maxAttempts) {
        const nextAttemptAt = now() + backoffMs(attempt, opts);
        const next = { ...n, attempt, nextAttemptAt };
        await redis.zadd(ZSET_DELIVERY_RETRY, nextAttemptAt, JSON.stringify(next));
      } else {
        await deadLetter({ ...n, attempt }, result.error);
      }
    }
    await redis.lrem(QUEUE_DELIVERY_PROCESSING, 1, raw);
  }

  async function moverLoop(): Promise<void> {
    while (running) {
      try {
        await moveDueRetries();
      } catch {
        /* retry next tick */
      }
      await sleep(pollMs);
    }
  }

  async function loop(): Promise<void> {
    while (running) {
      try {
        const raw = await redis.rpoplpush(QUEUE_DELIVERY, QUEUE_DELIVERY_PROCESSING);
        if (raw === null) {
          await sleep(pollMs);
          continue;
        }
        await handle(raw);
      } catch {
        await sleep(pollMs);
      }
    }
  }

  async function listDeadLetters(): Promise<DeadLetter[]> {
    return (await redis.lrange(LIST_DEAD_LETTERS, 0, -1)).map((s) => JSON.parse(s) as DeadLetter);
  }

  async function retryDeadLetter(id: string): Promise<Notification | null> {
    for (const raw of await redis.lrange(LIST_DEAD_LETTERS, 0, -1)) {
      const dl = JSON.parse(raw) as DeadLetter;
      if (dl.id !== id) continue;
      if ((await redis.lrem(LIST_DEAD_LETTERS, 1, raw)) < 1) return null;
      const n: Notification = { ...dl.notification, attempt: 0 };
      delete n.nextAttemptAt;
      await enqueue(n);
      return n;
    }
    return null;
  }

  async function channelStatus(): Promise<ChannelStatus[]> {
    const pending = new Map<string, number>();
    const dead = new Map<string, number>();
    const bump = (m: Map<string, number>, ch: string): void => void m.set(ch, (m.get(ch) ?? 0) + 1);
    const chOf = (s: string): string | null => {
      try {
        return (JSON.parse(s) as Notification).channel;
      } catch {
        return null;
      }
    };
    const lists = await Promise.all([
      redis.lrange(QUEUE_DELIVERY, 0, -1),
      redis.lrange(QUEUE_DELIVERY_PROCESSING, 0, -1),
      redis.zrange(ZSET_DELIVERY_RETRY, 0, -1),
    ]);
    for (const s of lists.flat()) {
      const ch = chOf(s);
      if (ch) bump(pending, ch);
    }
    for (const dl of await listDeadLetters()) bump(dead, dl.notification.channel);
    const ids = new Set<string>([...registry.ids(), ...pending.keys(), ...dead.keys()]);
    return [...ids].sort().map((id) => {
      const last = lastResult.get(id);
      const st: ChannelStatus = { id, healthy: last?.healthy ?? true, pending: pending.get(id) ?? 0, deadLetters: dead.get(id) ?? 0 };
      if (last?.lastError && !last.healthy) st.lastError = last.lastError;
      return st;
    });
  }

  return {
    enqueue,
    moveDueRetries,
    listDeadLetters,
    retryDeadLetter,
    channelStatus,
    async start() {
      if (running) return;
      await recover();
      running = true;
      loops = [moverLoop(), ...Array.from({ length: concurrency }, () => loop())];
    },
    async stop() {
      running = false;
      await Promise.all(loops);
      loops = [];
    },
  };
}
