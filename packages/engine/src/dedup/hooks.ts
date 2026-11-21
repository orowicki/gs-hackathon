import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { PREFIX, compareSeverity, dedupKey, type Alert, type AlertEvent, type Notification } from "@alerting/shared";
import { deterministicId } from "../ids.js";
import type { AlertHookContext, AlertHookResult, EngineHooks } from "../rules/runner.js";
import type { Logger } from "../rules/compile.js";
import type { AlertRepo } from "./repo.js";

export interface DedupOptions {
  redis: Redis;
  repo: AlertRepo;
  /** Optional throttle applied after the dedup id fix-up in beforeEnqueue. */
  throttle?: { beforeEnqueue(n: Notification): Promise<Notification | null> };
  /** Lock lifetime (ms, default 10000). */
  lockTtlMs?: number;
  /** How long to wait for a busy lock before failing (ms, default 5000). */
  lockWaitMs?: number;
  /** How long an event id is remembered for redelivery detection (s, default 3600). */
  seenTtlSec?: number;
  logger?: Logger;
}

const SEEN_PREFIX = `${PREFIX}dedupseen:`;
const LOCK_PREFIX = `${PREFIX}deduplock:`;
const UNLOCK = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

interface Outcome {
  skip?: boolean;
  alertId?: string;
  notify?: boolean;
  kind?: AlertEvent["kind"];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Dedup / auto-resolve hook. State: Redis maps rule+dedupKey -> current alert id; alerts live in the
 * repo (Postgres), which is authoritative for state. A per-key Redis lock serialises instances.
 */
export function createDedupHooks(opts: DedupOptions): EngineHooks {
  const { redis, repo } = opts;
  const lockTtlMs = opts.lockTtlMs ?? 10_000;
  const lockWaitMs = opts.lockWaitMs ?? 5000;
  const seenTtlSec = opts.seenTtlSec ?? 3600;

  async function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const token = randomUUID();
    const key = LOCK_PREFIX + name;
    const deadline = Date.now() + lockWaitMs;
    let delay = 2;
    while ((await redis.set(key, token, "PX", lockTtlMs, "NX")) !== "OK") {
      if (Date.now() >= deadline) throw new Error(`dedup: timed out waiting for lock ${name}`);
      await sleep(delay + Math.random() * delay);
      delay = Math.min(delay * 2, 50);
    }
    try {
      return await fn();
    } finally {
      await redis.eval(UNLOCK, 1, key, token).catch(() => undefined);
    }
  }

  async function onAlert(built: Alert, ctx: AlertHookContext): Promise<AlertHookResult> {
    const ruleId = ctx.rule.rule.id;
    const common = ctx.event.common as unknown as Record<string, unknown>;
    const isResolved = (common.sourceStatus ?? common.status) === "resolved";
    const mapKey = dedupKey(ruleId, built.dedupKey);
    const seenKey = `${SEEN_PREFIX}${ruleId}:${ctx.event.id}`;

    const skip = (): AlertHookResult => ({ alert: built, notify: false, skip: true });

    return withLock(`${ruleId}:${built.dedupKey}`, async () => {
      const remember = async (o: Outcome) => {
        await redis.set(seenKey, JSON.stringify(o), "EX", seenTtlSec);
      };

      // redelivery of an event we already applied: replay the outcome, do not count again
      const seen = await redis.get(seenKey);
      if (seen) {
        const o = JSON.parse(seen) as Outcome;
        const alert = o.alertId ? await repo.get(o.alertId) : null;
        if (o.skip || !alert) return skip();
        return { alert, notify: o.notify ?? false, kind: o.kind ?? "updated" };
      }

      const currentId = await redis.get(mapKey);
      const current = currentId ? await repo.get(currentId) : null;
      const active = current && current.state !== "resolved" ? current : null;

      if (!active) {
        if (isResolved) {
          await remember({ skip: true });
          return skip();
        }
        await repo.upsert(built);
        await redis.set(mapKey, built.id);
        await remember({ alertId: built.id, notify: true, kind: "created" });
        return { alert: built, notify: true, kind: "created" };
      }

      if (isResolved) {
        const resolved: Alert = {
          ...active,
          state: "resolved",
          lastSeen: built.lastSeen,
          resolvedAt: built.lastSeen,
          common: built.common,
        };
        (resolved as unknown as Record<string, unknown>).status = "resolved";
        await repo.upsert(resolved);
        await redis.del(mapKey);
        await remember({ alertId: resolved.id, notify: false, kind: "resolved" });
        return { alert: resolved, notify: false, kind: "resolved" };
      }

      const raised = compareSeverity(built.severity, active.severity) > 0;
      const updated: Alert = {
        ...active,
        count: active.count + 1,
        lastSeen: built.lastSeen,
        common: built.common,
        severity: raised ? built.severity : active.severity,
      };
      const kind: AlertEvent["kind"] = raised ? "severity_increased" : "updated";
      await repo.upsert(updated);
      await remember({ alertId: updated.id, notify: raised, kind });
      return { alert: updated, notify: raised, kind };
    });
  }

  async function beforeEnqueue(n: Notification, ctx: { kind?: AlertEvent["kind"] }) {
    let out = n;
    if (ctx.kind === "severity_increased") {
      // the first notification of this alert already used the id derived from alert+person+channel
      out = { ...n, id: deterministicId("notification", n.alertId, n.recipientId, n.channel, n.severity) };
    }
    return opts.throttle ? opts.throttle.beforeEnqueue(out) : out;
  }

  return { onAlert, beforeEnqueue };
}
