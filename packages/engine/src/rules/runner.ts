import { randomUUID } from "node:crypto";
import { deterministicId } from "../ids.js";
import type { Redis } from "ioredis";
import type { ConfigStore } from "@alerting/config";
import { createDeliveryQueue } from "@alerting/delivery";
import {
  CHANNEL_UI_PUSH,
  GROUP_ENGINE,
  STREAM_ALERTS,
  STREAM_EVENTS,
  type Alert,
  type AlertEvent,
  type Event,
  type Notification,
  type UiPush,
} from "@alerting/shared";
import { createDirectory, type Directory } from "../routing/directory.js";
import { routeAlert } from "../routing/route.js";
import { createRuleCache } from "./cache.js";
import type { CompiledRule, Logger } from "./compile.js";
import { renderLooks } from "./looks.js";
import { matchRules } from "./match.js";

export interface AlertHookContext {
  event: Event;
  rule: CompiledRule;
}

export interface AlertHookResult {
  alert: Alert;
  notify: boolean;
  /** Defaults to "created". */
  kind?: AlertEvent["kind"];
  /** Nothing to do for this match (no alert in the result, no notification, no publish). */
  skip?: boolean;
}

export interface EnqueueHookContext extends AlertHookContext {
  alert: Alert;
  kind: AlertEvent["kind"];
  entryId: string;
}

export interface EngineHooks {
  /** Seam for dedup/persistence: may replace the alert and suppress notifications. */
  onAlert?(alert: Alert, ctx: AlertHookContext): Promise<AlertHookResult | void> | AlertHookResult | void;
  /** Called before each enqueue: return the notification to send (possibly changed) or null to drop it. */
  beforeEnqueue?(n: Notification, ctx: EnqueueHookContext): Promise<Notification | null> | Notification | null;
}

export interface ProcessDeps {
  rules: CompiledRule[];
  directory: Directory;
  enqueue(n: Notification): Promise<unknown> | unknown;
  /** Called once per alert (also when notify is false). */
  publishAlert?(ae: AlertEvent, alert: Alert): Promise<unknown> | unknown;
  hooks?: EngineHooks;
  logger?: Logger;
  now?: () => Date;
  publicUrl?: string;
  /**
   * Stable identity of this delivery of the event (the stream entry id). Alert and notification
   * ids derive from it, so a retry produces the same ids. Defaults to event.id.
   */
  entryId?: string;
}

export interface ProcessResult {
  alerts: Alert[];
  notifications: Notification[];
  /** Rules whose processing or enqueue threw; the caller should not ack the event when non-empty. */
  failed: Array<{ ruleId: string; error: Error }>;
}

export function buildAlert(event: Event, rule: CompiledRule, at: Date, entryId: string = event.id): Alert {
  const looks = renderLooks(rule.rule, event);
  const c = event.common as Record<string, unknown>;
  const id = deterministicId("alert", entryId, rule.rule.id);
  const dedupFromFields = (rule.rule.dedupFields ?? [])
    .map((f) => c[f])
    .filter((v) => v !== undefined && v !== null)
    .join("|");
  const iso = at.toISOString();
  const alert: Record<string, unknown> = {
    id,
    ruleId: rule.rule.id,
    eventId: event.id,
    schemaId: event.schemaId,
    dedupKey: (c.dedupKey as string | undefined) || dedupFromFields || id,
    state: "open",
    status: "open",
    severity: looks.severity,
    title: looks.title,
    source: (c.source as string | undefined) ?? event.sourceId,
    environment: (c.environment as string | undefined) ?? "",
    count: 1,
    firstSeen: iso,
    lastSeen: iso,
    fields: looks.fields.map((f) => ({ label: f.path, value: f.value })),
    common: event.common,
  };
  if (looks.body !== undefined) alert.body = looks.body;
  if (looks.colour !== undefined) alert.colour = looks.colour;
  return alert as unknown as Alert;
}

/**
 * Pure core: match rules, build alerts, route, hand notifications to `enqueue`.
 * One failing rule does not stop the others; failures are logged and returned in `failed`.
 */
export async function processEvent(event: Event, deps: ProcessDeps): Promise<ProcessResult> {
  const logger = deps.logger ?? console;
  const result: ProcessResult = { alerts: [], notifications: [], failed: [] };
  for (const compiled of matchRules(event, deps.rules, logger)) {
    try {
      const now = deps.now?.() ?? new Date();
      let alert = buildAlert(event, compiled, now, deps.entryId ?? event.id);
      let notify = true;
      let kind: AlertEvent["kind"] = "created";
      const hooked = await deps.hooks?.onAlert?.(alert, { event, rule: compiled });
      if (hooked?.skip) continue;
      if (hooked) {
        alert = hooked.alert;
        notify = hooked.notify;
        kind = hooked.kind ?? kind;
      }
      result.alerts.push(alert);
      if (notify) {
        const ns = routeAlert({
          alert,
          event,
          rule: compiled,
          directory: deps.directory,
          now,
          logger,
          ...(deps.publicUrl !== undefined ? { publicUrl: deps.publicUrl } : {}),
        });
        for (const routed of ns) {
          const n = deps.hooks?.beforeEnqueue
            ? await deps.hooks.beforeEnqueue(routed, {
                event,
                rule: compiled,
                alert,
                kind,
                entryId: deps.entryId ?? event.id,
              })
            : routed;
          if (!n) continue;
          await deps.enqueue(n);
          result.notifications.push(n);
        }
      }
      await deps.publishAlert?.({ alertId: alert.id, kind, eventId: event.id, at: now.toISOString() }, alert);
    } catch (err) {
      logger.error(`rule ${compiled.rule.id} failed on event ${event.id}: ${(err as Error).message}`);
      result.failed.push({ ruleId: compiled.rule.id, error: err instanceof Error ? err : new Error(String(err)) });
    }
  }
  return result;
}

export interface EngineOptions {
  redis: Redis;
  store: ConfigStore;
  logger?: Logger;
  now?: () => Date;
  hooks?: EngineHooks;
  /** Block time per XREADGROUP (ms, default 1000). */
  blockMs?: number;
  /** How often stale pending entries are reclaimed (ms, default 5000). */
  reclaimEveryMs?: number;
  /** Minimum idle time before a pending entry is reclaimed (ms, default 30000). */
  reclaimMinIdleMs?: number;
  /** Deliveries after which an event is given up on (logged and acked; default 5). */
  maxDeliveries?: number;
}

export interface Engine {
  start(): Promise<void>;
  stop(): Promise<void>;
}

type Entries = Array<[string, string[]]>;

export function createEngine(opts: EngineOptions): Engine {
  const logger = opts.logger ?? console;
  const consumer = `engine-${process.pid}-${randomUUID().slice(0, 8)}`;
  const blockMs = opts.blockMs ?? 1000;
  const reclaimEveryMs = opts.reclaimEveryMs ?? 5000;
  const reclaimMinIdleMs = opts.reclaimMinIdleMs ?? 30_000;
  const maxDeliveries = opts.maxDeliveries ?? 5;
  const queue = createDeliveryQueue(opts.redis);
  let running = false;
  let loop: Promise<void> | undefined;
  let reader: Redis | undefined;
  let rules: ReturnType<typeof createRuleCache> | undefined;
  let directory: Directory | undefined;

  const publishAlert = async (ae: AlertEvent) => {
    await opts.redis.xadd(STREAM_ALERTS, "*", "data", JSON.stringify(ae));
    const push: UiPush = { type: "alert", alertId: ae.alertId, kind: ae.kind };
    await opts.redis.publish(CHANNEL_UI_PUSH, JSON.stringify(push));
  };

  const ensureGroup = async () => {
    try {
      // id 0: events written before the group first existed are processed too
      await opts.redis.xgroup("CREATE", STREAM_EVENTS, GROUP_ENGINE, "0", "MKSTREAM");
    } catch (err) {
      if (!String((err as Error).message).includes("BUSYGROUP")) throw err;
    }
  };

  const ack = async (id: string) => {
    try {
      await opts.redis.xack(STREAM_EVENTS, GROUP_ENGINE, id);
    } catch (err) {
      logger.error(`engine: ack ${id} failed: ${(err as Error).message}`);
    }
  };

  /** Process one stream entry; ack only on success, otherwise leave it pending for a retry. */
  const handle = async (id: string, fields: string[]) => {
    let event: Event;
    try {
      const i = fields.indexOf("data");
      event = JSON.parse(fields[i + 1] ?? "") as Event;
    } catch (err) {
      logger.error(`engine: event ${id} is not valid JSON, dropped: ${(err as Error).message}`);
      await ack(id);
      return;
    }
    try {
      const res = await processEvent(event, {
        rules: rules!.rules(),
        directory: directory!,
        enqueue: (n) => queue.enqueue(n),
        publishAlert,
        ...(opts.hooks ? { hooks: opts.hooks } : {}),
        logger,
        ...(opts.now ? { now: opts.now } : {}),
        entryId: id,
      });
      if (res.failed.length > 0) {
        logger.error(`engine: event ${id} left pending, ${res.failed.length} rule(s) failed (will retry)`);
        return;
      }
    } catch (err) {
      logger.error(`engine: event ${id} failed, left pending: ${(err as Error).message}`);
      return;
    }
    await ack(id);
  };

  const deliveryCount = async (id: string): Promise<number> => {
    const r = (await opts.redis.xpending(STREAM_EVENTS, GROUP_ENGINE, id, id, 1)) as unknown as Array<
      [string, string, number, number]
    >;
    return Number(r?.[0]?.[3] ?? 0);
  };

  /** Claim entries idle for too long (any consumer), retry them, and give up after maxDeliveries. */
  const reclaim = async () => {
    let cursor = "0-0";
    do {
      const res = (await reader!.xautoclaim(
        STREAM_EVENTS,
        GROUP_ENGINE,
        consumer,
        reclaimMinIdleMs,
        cursor,
        "COUNT",
        10,
      )) as unknown as [string, Entries, ...unknown[]];
      cursor = res[0];
      for (const [id, fields] of res[1] ?? []) {
        if (!running) return;
        if (!fields) {
          // entry was trimmed from the stream; nothing to retry
          await ack(id);
          continue;
        }
        let n = 0;
        try {
          n = await deliveryCount(id);
        } catch (err) {
          logger.error(`engine: xpending ${id} failed: ${(err as Error).message}`);
        }
        if (n >= maxDeliveries) {
          logger.error(`engine: event ${id} gave up after ${n} deliveries, acking`);
          await ack(id);
          continue;
        }
        await handle(id, fields);
      }
    } while (running && cursor !== "0-0");
  };

  const run = async () => {
    let lastReclaim = Date.now();
    while (running) {
      try {
        if (Date.now() - lastReclaim >= reclaimEveryMs) {
          lastReclaim = Date.now();
          await reclaim();
        }
        const res = (await reader!.xreadgroup(
          "GROUP",
          GROUP_ENGINE,
          consumer,
          "COUNT",
          10,
          "BLOCK",
          blockMs,
          "STREAMS",
          STREAM_EVENTS,
          ">",
        )) as Array<[string, Entries]> | null;
        if (!res) continue;
        for (const [, entries] of res) for (const [id, fields] of entries) await handle(id, fields);
      } catch (err) {
        if (!running) return;
        const msg = (err as Error).message ?? String(err);
        logger.error(`engine: read failed: ${msg}`);
        if (msg.includes("NOGROUP")) {
          try {
            await ensureGroup();
            continue;
          } catch (e) {
            logger.error(`engine: re-creating group failed: ${(e as Error).message}`);
          }
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  };

  return {
    async start() {
      if (running) return;
      rules = createRuleCache(opts.store, { logger });
      directory = createDirectory(opts.store, { logger });
      try {
        await Promise.all([rules.ready, directory.ready]);
        await ensureGroup();
        reader = opts.redis.duplicate();
      } catch (err) {
        rules.close();
        directory.close();
        rules = undefined;
        directory = undefined;
        throw err;
      }
      running = true;
      loop = run();
    },
    async stop() {
      running = false;
      if (reader) {
        try {
          await reader.quit();
        } catch {
          reader.disconnect();
        }
      }
      await loop;
      rules?.close();
      directory?.close();
      reader = undefined;
      loop = undefined;
    },
  };
}
