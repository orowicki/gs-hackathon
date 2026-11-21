import type { Redis } from "ioredis";
import {
  PREFIX,
  dedupKey,
  type Alert,
  type AlertEvent,
  type Notification,
} from "@alerting/shared";
import { deterministicId } from "../ids.js";
import type {
  AlertHookContext,
  AlertHookResult,
  EngineHooks,
} from "../rules/runner.js";
import type { Logger } from "../rules/compile.js";
import type { AlertRepo } from "./repo.js";

export interface DedupOptions {
  redis: Redis;
  repo: AlertRepo;
  /** Optional throttle applied after the dedup id fix-up in beforeEnqueue. */
  throttle?: { beforeEnqueue(n: Notification): Promise<Notification | null> };
  /** How long an event id is remembered for redelivery detection (s, default 3600). */
  seenTtlSec?: number;
  logger?: Logger;
}

const SEEN_PREFIX = `${PREFIX}dedupseen:`;

const PENDING = "pending";
const PENDING_MS = 60_000;

interface Outcome {
  skip?: boolean;
  alertId?: string;
  notify?: boolean;
  kind?: AlertEvent["kind"];
}

/**
 * Dedup / auto-resolve hook. The repo (Postgres) is authoritative: it holds at most one unresolved
 * alert per (rule, dedupKey) and create-or-bump is one atomic statement (`upsertOpen`), so any
 * number of workers can race on a key without a lock. Redis only keeps the per-event "seen" marker
 * (redelivery replay, no double count) and an informational rule+dedupKey -> open alert id map
 * written on create and cleared on resolve. A crash after the bump but before the seen-marker is
 * written double-counts that one event on redelivery (at-least-once).
 */
export function createDedupHooks(opts: DedupOptions): EngineHooks {
  const { redis, repo } = opts;
  const seenTtlSec = opts.seenTtlSec ?? 3600;

  async function onAlert(
    built: Alert,
    ctx: AlertHookContext,
  ): Promise<AlertHookResult> {
    const ruleId = ctx.rule.rule.id;
    const common = ctx.event.common as unknown as Record<string, unknown>;
    const isResolved = (common.sourceStatus ?? common.status) === "resolved";
    const mapKey = dedupKey(ruleId, built.dedupKey);
    const seenKey = `${SEEN_PREFIX}${ruleId}:${built.dedupKey}:${ctx.event.id}`;

    const skip = (): AlertHookResult => ({
      alert: built,
      notify: false,
      skip: true,
    });
    const remember = async (o: Outcome) => {
      await redis.set(seenKey, JSON.stringify(o), "EX", seenTtlSec);
    };

    // Claim the event atomically: two workers handling the same entry (e.g. reclaimed while the first
    // is still busy) must not both apply it. A pending claim makes the second one fail so its entry
    // stays pending and is retried later; a finished one replays the stored outcome.
    if ((await redis.set(seenKey, PENDING, "PX", PENDING_MS, "NX")) !== "OK") {
      const seen = await redis.get(seenKey);
      if (!seen || seen === PENDING)
        throw new Error(
          `dedup: event ${ctx.event.id} is being processed elsewhere`,
        );
      const o = JSON.parse(seen) as Outcome;
      const alert = o.alertId ? await repo.get(o.alertId) : null;
      if (o.skip || !alert) return skip();
      return { alert, notify: o.notify ?? false, kind: o.kind ?? "updated" };
    }
    try {
      return await apply();
    } catch (err) {
      await redis.del(seenKey).catch(() => undefined);
      throw err;
    }

    async function apply(): Promise<AlertHookResult> {
      if (isResolved) {
        const resolved = await repo.resolveOpen(
          ruleId,
          built.dedupKey,
          built.lastSeen,
          built.common,
        );
        if (!resolved) {
          await remember({ skip: true });
          return skip();
        }
        await redis.del(mapKey);
        await remember({
          alertId: resolved.id,
          notify: false,
          kind: "resolved",
        });
        return { alert: resolved, notify: false, kind: "resolved" };
      }

      const res = await repo.upsertOpen(built);
      if (res) {
        if (res.created) {
          await redis.set(mapKey, res.alert.id);
          await remember({
            alertId: res.alert.id,
            notify: true,
            kind: "created",
          });
          return { alert: res.alert, notify: true, kind: "created" };
        }
        const kind: AlertEvent["kind"] = res.raised
          ? "severity_increased"
          : "updated";
        await remember({ alertId: res.alert.id, notify: res.raised, kind });
        return { alert: res.alert, notify: res.raised, kind };
      }

      // crash recovery: this very event (deterministic id) already created its alert but never got
      // as far as the marker; reuse it instead of counting it again or opening a duplicate
      const own = await repo.get(built.id);
      if (!own || own.state === "resolved") {
        await remember({ skip: true });
        return skip();
      }
      // never overwrite a map entry that points to another (newer) alert
      const claimed =
        (await redis.set(mapKey, own.id, "NX")) === "OK" ||
        (await redis.get(mapKey)) === own.id;
      const notify = claimed && own.count === 1 && own.state === "open";
      const kind: AlertEvent["kind"] = notify ? "created" : "updated";
      await remember({ alertId: own.id, notify, kind });
      return { alert: own, notify, kind };
    }
  }

  async function beforeEnqueue(
    n: Notification,
    ctx: { kind?: AlertEvent["kind"] },
  ) {
    let out = n;
    if (ctx.kind === "severity_increased") {
      // the first notification of this alert already used the id derived from alert+person+channel
      out = {
        ...n,
        id: deterministicId(
          "notification",
          n.alertId,
          n.recipientId,
          n.channel,
          n.severity,
        ),
      };
    }
    return opts.throttle ? opts.throttle.beforeEnqueue(out) : out;
  }

  return { onAlert, beforeEnqueue };
}
