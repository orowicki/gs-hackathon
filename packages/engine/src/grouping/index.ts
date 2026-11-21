import { createHash } from "node:crypto";
import type { Redis } from "ioredis";
import { PREFIX, SEVERITY_ORDER, type Alert, type Event, type Notification, type Rule, type Severity } from "@alerting/shared";
import { deterministicId } from "../ids.js";
import { parseDuration } from "./duration.js";

export { parseDuration } from "./duration.js";

/** Group lists: `alerting:group:<hash>`. Due zset: score = epoch ms due, member = group hash. */
export const GROUP_PREFIX = `${PREFIX}group:`;
export const ZSET_GROUP_DUE = `${PREFIX}groupdue`;
export const groupListKey = (hash: string): string => `${GROUP_PREFIX}${hash}`;

export interface GroupingContext {
  rule: { rule: Rule };
  event: Event;
  alert: Alert;
}

export interface GroupingOptions {
  redis: Redis;
  /** Sends a flushed group notification (main.ts: throttle, then the delivery queue). */
  deliver(n: Notification): Promise<unknown> | unknown;
  now?: () => number;
  tickMs?: number;
  /** How long an instance owns a group it is sending before another may take over (ms, default 30000). */
  leaseMs?: number;
  logger?: Pick<Console, "error">;
}

export interface Grouping {
  /** The notification to send now (rule without grouping), or null when it was buffered. */
  beforeEnqueue(n: Notification, ctx: GroupingContext): Promise<Notification | null>;
  /** Delivers every group whose window has ended; returns how many groups were delivered. */
  flushDue(nowMs?: number): Promise<number>;
  start(): void;
  stop(): Promise<void>;
}

/** Active grouping config of a rule, or null. */
export function groupingOf(rule: Rule): { by: string[]; windowMs: number } | null {
  const by = rule.groupBy;
  if (!Array.isArray(by) || by.length === 0 || !by.every((f) => typeof f === "string" && f !== "")) return null;
  const windowMs = parseDuration(rule.groupWindow);
  return windowMs === null ? null : { by, windowMs };
}

function dotted(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

const text = (v: unknown): string | undefined =>
  v === undefined || v === null ? undefined : typeof v === "object" ? JSON.stringify(v) : String(v);

/** Value of a groupBy field: known alert field first, else dotted path in the event (then parsed, common). */
export function groupValue(field: string, alert: Alert, event: Event): string {
  if (!field.includes(".") && field in alert) {
    const v = (alert as unknown as Record<string, unknown>)[field];
    if (v === null || typeof v !== "object") return text(v) ?? "";
  }
  return text(dotted(event, field)) ?? text(dotted(event.parsed, field)) ?? text(dotted(event.common, field)) ?? "";
}

export function groupHash(ruleId: string, values: string[], recipientId: string, channel: string): string {
  return createHash("sha256").update(JSON.stringify([ruleId, values, recipientId, channel])).digest("hex").slice(0, 32);
}

interface Stored {
  n: Notification;
  rule: string;
}

// KEYS: list, due zset. ARGV: due time, member, json. Schedule the flush only for the first item.
const PUSH = `
local len = redis.call('rpush', KEYS[1], ARGV[3])
if len == 1 then redis.call('zadd', KEYS[2], ARGV[1], ARGV[2]) else redis.call('zadd', KEYS[2], 'NX', ARGV[1], ARGV[2]) end
return len`;
// KEYS: due zset. ARGV: now, lease-until, member. Claim = move the due time into the future, once.
const CLAIM = `
local s = redis.call('zscore', KEYS[1], ARGV[3])
if s and tonumber(s) <= tonumber(ARGV[1]) then redis.call('zadd', KEYS[1], ARGV[2], ARGV[3]) return 1 end
return 0`;
// KEYS: list, due zset. ARGV: sent count, member, retry-at. Drop what was sent; reschedule leftovers
// (items pushed while the group was being sent), which start a fresh window.
const FINISH = `
redis.call('ltrim', KEYS[1], tonumber(ARGV[1]), -1)
if redis.call('llen', KEYS[1]) == 0 then redis.call('zrem', KEYS[2], ARGV[2])
else redis.call('zadd', KEYS[2], tonumber(ARGV[3]), ARGV[2]) end
return 1`;

export function buildGroup(items: Stored[], key: string, at: Date): Notification {
  const first = items[0]!.n;
  let severity: Severity = first.severity;
  for (const i of items) if (SEVERITY_ORDER[i.n.severity] > SEVERITY_ORDER[severity]) severity = i.n.severity;
  const alertIds = [...new Set(items.flatMap((i) => i.n.digestAlertIds ?? [i.n.alertId]))];
  const label = items[0]!.rule || first.title;
  const titles = items.slice(0, 10).map((i) => `- ${i.n.title}`);
  if (items.length > 10) titles.push(`and ${items.length - 10} more`);
  return {
    id: deterministicId("group", key, first.id),
    alertId: first.alertId,
    recipientId: first.recipientId,
    channel: first.channel,
    severity,
    title: `${items.length} alerts: ${label}`,
    body: titles.join("\n"),
    clickUrl: first.clickUrl,
    ...(first.runbookUrl !== undefined ? { runbookUrl: first.runbookUrl } : {}),
    digestAlertIds: alertIds,
    attempt: 0,
    createdAt: at.toISOString(),
  };
}

export function createGrouping(opts: GroupingOptions): Grouping {
  const { redis } = opts;
  const now = opts.now ?? Date.now;
  const leaseMs = opts.leaseMs ?? 30_000;
  const logger = opts.logger ?? console;
  let timer: NodeJS.Timeout | undefined;
  let flushing: Promise<unknown> = Promise.resolve();

  async function beforeEnqueue(n: Notification, ctx: GroupingContext): Promise<Notification | null> {
    const rule = ctx.rule.rule;
    const g = groupingOf(rule);
    if (!g) return n;
    const values = g.by.map((f) => groupValue(f, ctx.alert, ctx.event));
    const key = groupHash(rule.id, values, n.recipientId, n.channel);
    const stored: Stored = { n, rule: rule.name ?? "" };
    await redis.eval(PUSH, 2, groupListKey(key), ZSET_GROUP_DUE, now() + g.windowMs, key, JSON.stringify(stored));
    return null;
  }

  async function flushDue(nowMs: number = now()): Promise<number> {
    const due = await redis.zrangebyscore(ZSET_GROUP_DUE, "-inf", nowMs);
    let sent = 0;
    for (const member of due) {
      const claimed = await redis.eval(CLAIM, 1, ZSET_GROUP_DUE, nowMs, nowMs + leaseMs, member);
      if (Number(claimed) !== 1) continue;
      const lk = groupListKey(member);
      const raw = await redis.lrange(lk, 0, -1);
      if (raw.length === 0) {
        await redis.zrem(ZSET_GROUP_DUE, member);
        continue;
      }
      const items = raw.map((r) => JSON.parse(r) as Stored);
      try {
        await opts.deliver(items.length === 1 ? items[0]!.n : buildGroup(items, member, new Date(nowMs)));
      } catch (err) {
        logger.error(`grouping: group ${member} failed, will retry: ${(err as Error).message}`);
        await redis.zadd(ZSET_GROUP_DUE, nowMs + 1000, member);
        continue;
      }
      await redis.eval(FINISH, 2, lk, ZSET_GROUP_DUE, raw.length, member, nowMs + 1000);
      sent++;
    }
    return sent;
  }

  return {
    beforeEnqueue,
    flushDue,
    start() {
      if (timer) return;
      timer = setInterval(() => {
        flushing = flushing.then(() => flushDue()).catch((err) => logger.error(`grouping: flush failed: ${(err as Error).message}`));
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
