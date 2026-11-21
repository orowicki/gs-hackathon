import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import {
  CHANNEL_UI_PUSH,
  LIST_DEAD_LETTERS,
  QUEUE_DELIVERY,
  QUEUE_DELIVERY_PROCESSING,
  ZSET_DELIVERY_RETRY,
  type ChannelStatus,
  type DeadLetter,
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
  /** Attempts for failures other than "channel unavailable" (default 5). */
  maxAttempts?: number;
  /** Channel-unavailable failures retry (not counting toward maxAttempts) until this long after the first one (default 24 h). */
  maxOutageMs?: number;
  /** Parallel worker loops (default 1, capped at 32). */
  concurrency?: number;
  /** Items each loop moves, sends and acknowledges per round trip (default 1 = one item at a time). */
  batchSize?: number;
  /** Poll interval when busy (ms); backs off to ~500 ms when idle. */
  pollMs?: number;
  /** Worker heartbeat refresh interval (default 5 s) and lease TTL (default 15 s). */
  heartbeatMs?: number;
  leaseMs?: number;
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
  /** Move items of workers whose heartbeat lease expired (and legacy processing items) back to the queue. */
  reapDeadWorkers(): Promise<number>;
}

const WORKERS_SET = `${QUEUE_DELIVERY_PROCESSING}:workers`;
const IDLE_MAX_MS = 500;
/** Atomically move up to ARGV[1] items from the tail of KEYS[1] to the head of KEYS[2]; returns them in pop order. */
const POP_BATCH_LUA = `local out = {}
for i = 1, tonumber(ARGV[1]) do
  local v = redis.call('RPOPLPUSH', KEYS[1], KEYS[2])
  if not v then break end
  out[#out + 1] = v
end
return out`;

/** Throws if any command inside an exec()'d MULTI failed; returns the raw results. */
function execAll(res: [Error | null, unknown][] | null): unknown[] {
  if (!res) throw new Error("MULTI aborted");
  return res.map(([err, v]) => {
    if (err) throw err;
    return v;
  });
}

type ChainableMulti = ReturnType<Redis["multi"]>;
type SendResult = Awaited<ReturnType<ChannelRegistry["send"]>>;

export function createDeliveryQueue(redis: Redis, opts: DeliveryQueueOptions = {}): DeliveryQueue {
  const registry = opts.registry ?? defaultRegistry;
  const maxAttempts = opts.maxAttempts ?? 5;
  const maxOutageMs = opts.maxOutageMs ?? 24 * 3600_000;
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 1, 32));
  const batchSize = Math.max(1, Math.floor(opts.batchSize ?? 1));
  const pollMs = opts.pollMs ?? 50;
  const heartbeatMs = opts.heartbeatMs ?? 5000;
  const leaseMs = opts.leaseMs ?? 15_000;
  const now = opts.now ?? Date.now;
  const workerId = randomUUID();
  const myList = `${QUEUE_DELIVERY_PROCESSING}:${workerId}`;
  const myAlive = `${myList}:alive`;
  const lastResult = new Map<string, { healthy: boolean; lastError?: string }>();
  let running = false;
  let loops: Promise<void>[] = [];
  let heartbeat: NodeJS.Timeout | undefined;
  let lastReap = 0;
  let corruptSeq = 0;

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  async function enqueue(n: QueuedNotification): Promise<void> {
    await redis.lpush(QUEUE_DELIVERY, JSON.stringify(n));
  }

  /** Atomically move `member` from a ZSET/list source to the queue. true if this caller moved it. */
  async function moveToQueue(kind: "zset" | "list", key: string, member: string): Promise<boolean> {
    // Push first, remove second, in one MULTI; if the removal found nothing (someone else moved it),
    // take back our copy. No loss: the member is always in the queue or its source.
    const m = redis.multi().lpush(QUEUE_DELIVERY, member);
    if (kind === "zset") m.zrem(key, member);
    else m.lrem(key, 1, member);
    const removed = execAll(await m.exec())[1] as number;
    if (removed >= 1) return true;
    await redis.lrem(QUEUE_DELIVERY, 1, member);
    return false;
  }

  async function moveDueRetries(): Promise<number> {
    const due = await redis.zrangebyscore(ZSET_DELIVERY_RETRY, "-inf", now());
    let moved = 0;
    for (const member of due) if (await moveToQueue("zset", ZSET_DELIVERY_RETRY, member)) moved++;
    return moved;
  }

  async function drainToQueue(list: string): Promise<number> {
    let n = 0;
    while ((await redis.rpoplpush(list, QUEUE_DELIVERY)) !== null) n++;
    return n;
  }

  async function reapDeadWorkers(): Promise<number> {
    let moved = await drainToQueue(QUEUE_DELIVERY_PROCESSING); // legacy shared list
    for (const id of await redis.smembers(WORKERS_SET)) {
      const list = `${QUEUE_DELIVERY_PROCESSING}:${id}`;
      if (id === workerId && running) continue;
      if ((await redis.exists(`${list}:alive`)) === 1) continue;
      moved += await drainToQueue(list);
      await redis.srem(WORKERS_SET, id);
    }
    return moved;
  }

  async function beat(): Promise<void> {
    await redis.set(myAlive, "1", "PX", leaseMs);
    await redis.sadd(WORKERS_SET, workerId);
  }

  async function announceDeadLetters(): Promise<void> {
    try {
      const count = await redis.llen(LIST_DEAD_LETTERS);
      await redis.publish(CHANNEL_UI_PUSH, JSON.stringify({ type: "dead_letter", count }));
    } catch {
      /* best-effort live push */
    }
  }

  /** Parse a queued payload; null when it is corrupt. */
  function parsePayload(raw: string): QueuedNotification | null {
    try {
      const n = JSON.parse(raw) as QueuedNotification;
      if (!n || typeof n !== "object" || typeof n.channel !== "string") throw new Error("shape");
      return n;
    } catch {
      return null;
    }
  }

  /** Add the dead-letter for an unparseable payload plus its removal from processing onto `m`. */
  function addCorrupt(m: ChainableMulti, raw: string): void {
    const placeholder: Notification = {
      id: `corrupt-${now()}-${corruptSeq++}`,
      alertId: "",
      recipientId: "",
      channel: "unknown",
      severity: "error",
      title: raw.slice(0, 200),
      clickUrl: "/",
      attempt: 0,
      createdAt: new Date(now()).toISOString(),
    };
    const dl: DeadLetter = { id: placeholder.id, notification: placeholder, error: "unparseable payload", failedAt: new Date(now()).toISOString() };
    m.lpush(LIST_DEAD_LETTERS, JSON.stringify(dl)).lrem(myList, 1, raw);
  }

  /** Add the outcome commands of a send (retry zadd / dead letter) and the lrem of `raw` onto `m`; true if dead-lettered. */
  function addOutcome(m: ChainableMulti, n: QueuedNotification, raw: string, result: SendResult): boolean {
    let dead = false;
    if (result.status === "delivered") {
      lastResult.set(n.channel, { healthy: true });
    } else {
      lastResult.set(n.channel, { healthy: false, lastError: result.error });
      const unavailable = "unavailable" in result && result.unavailable === true;
      const attempt = (n.attempt ?? 0) + 1;
      if (unavailable) {
        const outageSince = n.outageSince ?? now();
        if (now() - outageSince < maxOutageMs) {
          const outageCount = (n.outageCount ?? 0) + 1;
          const nextAttemptAt = now() + backoffMs(outageCount, opts);
          m.zadd(ZSET_DELIVERY_RETRY, nextAttemptAt, JSON.stringify({ ...n, outageSince, outageCount, nextAttemptAt }));
        } else {
          dead = true;
          m.lpush(LIST_DEAD_LETTERS, JSON.stringify(mkDead({ ...n, attempt }, result.error)));
        }
      } else if (result.retryable && attempt < maxAttempts) {
        const nextAttemptAt = now() + backoffMs(attempt, opts);
        m.zadd(ZSET_DELIVERY_RETRY, nextAttemptAt, JSON.stringify({ ...n, attempt, nextAttemptAt }));
      } else {
        dead = true;
        m.lpush(LIST_DEAD_LETTERS, JSON.stringify(mkDead({ ...n, attempt }, result.error)));
      }
    }
    m.lrem(myList, 1, raw);
    return dead;
  }

  async function handle(raw: string): Promise<void> {
    const n = parsePayload(raw);
    const m = redis.multi();
    if (!n) {
      addCorrupt(m, raw);
      execAll(await m.exec());
      await announceDeadLetters();
      return;
    }
    const dead = addOutcome(m, n, raw, await registry.send(n));
    execAll(await m.exec());
    if (dead) await announceDeadLetters();
  }

  /** Send a batch (already moved to myList) in pop order, then acknowledge all outcomes in one MULTI. */
  async function handleBatch(raws: string[]): Promise<void> {
    const parsed = raws.map(parsePayload);
    const failed = new Set<number>(); // sends that threw: rescued, not acked
    const results = await Promise.all(
      raws.map(async (_, i) => {
        const n = parsed[i];
        if (!n) return null;
        try {
          return await registry.send(n);
        } catch {
          failed.add(i);
          return null;
        }
      }),
    );
    const m = redis.multi();
    let dead = false;
    const acked: string[] = [];
    raws.forEach((raw, i) => {
      const n = parsed[i];
      if (failed.has(i)) return;
      acked.push(raw);
      if (!n) {
        addCorrupt(m, raw);
        dead = true;
      } else if (addOutcome(m, n, raw, results[i] as SendResult)) dead = true;
    });
    try {
      if (acked.length > 0) execAll(await m.exec());
    } catch {
      for (const raw of acked) await rescue(raw);
      return;
    } finally {
      for (const i of failed) await rescue(raws[i] as string);
    }
    if (dead) await announceDeadLetters();
  }

  function mkDead(n: Notification, error: string): DeadLetter {
    return { id: n.id, notification: n, error, failedAt: new Date(now()).toISOString() };
  }

  /** After a failed step, put an in-flight item back on the queue so it is never stranded in processing. */
  async function rescue(raw: string): Promise<void> {
    while (running) {
      try {
        // No-op (returns false) if the step's MULTI already committed and removed it from processing.
        await moveToQueue("list", myList, raw);
        return;
      } catch {
        await sleep(Math.max(pollMs, 100));
      }
    }
    // Stopping: leave it; the lease reaper recovers it.
  }

  async function moverLoop(): Promise<void> {
    let idle = pollMs;
    while (running) {
      let moved = 0;
      try {
        moved = await moveDueRetries();
        if (Date.now() - lastReap >= heartbeatMs) {
          lastReap = Date.now();
          await reapDeadWorkers();
        }
      } catch {
        /* retry next tick */
      }
      idle = moved > 0 ? pollMs : Math.min(IDLE_MAX_MS, idle * 2);
      await sleep(idle);
    }
  }

  async function batchLoop(): Promise<void> {
    let idle = pollMs;
    while (running) {
      let raws: string[] = [];
      try {
        raws = (await redis.eval(POP_BATCH_LUA, 2, QUEUE_DELIVERY, myList, batchSize)) as string[];
        if (raws.length === 0) {
          await sleep(idle);
          idle = Math.min(IDLE_MAX_MS, idle * 2);
          continue;
        }
        idle = pollMs;
        await handleBatch(raws);
      } catch {
        for (const raw of raws) await rescue(raw);
        await sleep(pollMs);
      }
    }
  }

  async function loop(): Promise<void> {
    let idle = pollMs;
    while (running) {
      let raw: string | null = null;
      try {
        raw = await redis.rpoplpush(QUEUE_DELIVERY, myList);
        if (raw === null) {
          await sleep(idle);
          idle = Math.min(IDLE_MAX_MS, idle * 2);
          continue;
        }
        idle = pollMs;
        await handle(raw);
      } catch {
        if (raw !== null) await rescue(raw);
        await sleep(pollMs);
      }
    }
  }

  async function listDeadLetters(): Promise<DeadLetter[]> {
    const out: DeadLetter[] = [];
    for (const s of await redis.lrange(LIST_DEAD_LETTERS, 0, -1)) {
      try {
        const dl = JSON.parse(s) as DeadLetter;
        if (dl && typeof dl === "object" && dl.notification && typeof dl.id === "string") out.push(dl);
      } catch {
        /* corrupt entry: skipped */
      }
    }
    return out;
  }

  async function retryDeadLetter(id: string): Promise<Notification | null> {
    for (const raw of await redis.lrange(LIST_DEAD_LETTERS, 0, -1)) {
      let dl: DeadLetter;
      try {
        dl = JSON.parse(raw) as DeadLetter;
      } catch {
        continue;
      }
      if (!dl || dl.id !== id || !dl.notification) continue;
      const n: QueuedNotification = { ...dl.notification, attempt: 0 };
      delete n.nextAttemptAt;
      delete n.outageSince;
      delete n.outageCount;
      const json = JSON.stringify(n);
      const removed = execAll(await redis.multi().lpush(QUEUE_DELIVERY, json).lrem(LIST_DEAD_LETTERS, 1, raw).exec())[1] as number;
      if (removed < 1) {
        await redis.lrem(QUEUE_DELIVERY, 1, json); // lost the race to another retry
        return null;
      }
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
        const c = (JSON.parse(s) as Notification | null)?.channel;
        return typeof c === "string" ? c : null;
      } catch {
        return null;
      }
    };
    const workers = await redis.smembers(WORKERS_SET);
    const lists = await Promise.all([
      redis.lrange(QUEUE_DELIVERY, 0, -1),
      redis.lrange(QUEUE_DELIVERY_PROCESSING, 0, -1),
      redis.zrange(ZSET_DELIVERY_RETRY, 0, -1),
      ...workers.map((w) => redis.lrange(`${QUEUE_DELIVERY_PROCESSING}:${w}`, 0, -1)),
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
    reapDeadWorkers,
    listDeadLetters,
    retryDeadLetter,
    channelStatus,
    async start() {
      if (running) return;
      await beat();
      await reapDeadWorkers();
      running = true;
      lastReap = Date.now();
      heartbeat = setInterval(() => void beat().catch(() => undefined), heartbeatMs);
      heartbeat.unref();
      loops = [moverLoop(), ...Array.from({ length: concurrency }, () => (batchSize > 1 ? batchLoop() : loop()))];
    },
    async stop() {
      running = false;
      clearInterval(heartbeat);
      await Promise.all(loops);
      loops = [];
      try {
        await drainToQueue(myList);
        await redis.multi().del(myAlive).srem(WORKERS_SET, workerId).exec();
      } catch {
        /* lease expiry lets another worker's reaper recover leftovers */
      }
    },
  };
}
