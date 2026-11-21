import { randomUUID } from "node:crypto";
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
}

export interface EngineHooks {
  /** Seam for dedup/persistence: may replace the alert and suppress notifications. */
  onAlert?(alert: Alert, ctx: AlertHookContext): Promise<AlertHookResult | void> | AlertHookResult | void;
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
}

export interface ProcessResult {
  alerts: Alert[];
  notifications: Notification[];
}

export function buildAlert(event: Event, rule: CompiledRule, at: Date): Alert {
  const looks = renderLooks(rule.rule, event);
  const c = event.common as Record<string, unknown>;
  const id = randomUUID();
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

/** Pure core: match rules, build alerts, route, hand notifications to `enqueue`. Never throws for one bad rule. */
export async function processEvent(event: Event, deps: ProcessDeps): Promise<ProcessResult> {
  const logger = deps.logger ?? console;
  const result: ProcessResult = { alerts: [], notifications: [] };
  for (const compiled of matchRules(event, deps.rules)) {
    try {
      const now = deps.now?.() ?? new Date();
      let alert = buildAlert(event, compiled, now);
      let notify = true;
      let kind: AlertEvent["kind"] = "created";
      const hooked = await deps.hooks?.onAlert?.(alert, { event, rule: compiled });
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
        for (const n of ns) {
          await deps.enqueue(n);
          result.notifications.push(n);
        }
      }
      await deps.publishAlert?.({ alertId: alert.id, kind, eventId: event.id, at: now.toISOString() }, alert);
    } catch (err) {
      logger.error(`rule ${compiled.rule.id} failed on event ${event.id}: ${(err as Error).message}`);
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
}

export interface Engine {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createEngine(opts: EngineOptions): Engine {
  const logger = opts.logger ?? console;
  const consumer = `engine-${process.pid}-${randomUUID().slice(0, 8)}`;
  const blockMs = opts.blockMs ?? 1000;
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

  const handle = async (id: string, fields: string[]) => {
    try {
      const i = fields.indexOf("data");
      const event = JSON.parse(fields[i + 1] ?? "") as Event;
      await processEvent(event, {
        rules: rules!.rules(),
        directory: directory!,
        enqueue: (n) => queue.enqueue(n),
        publishAlert,
        ...(opts.hooks ? { hooks: opts.hooks } : {}),
        logger,
        ...(opts.now ? { now: opts.now } : {}),
      });
    } catch (err) {
      logger.error(`engine: event ${id} failed: ${(err as Error).message}`);
    }
    try {
      await opts.redis.xack(STREAM_EVENTS, GROUP_ENGINE, id);
    } catch (err) {
      logger.error(`engine: ack ${id} failed: ${(err as Error).message}`);
    }
  };

  const run = async () => {
    while (running) {
      try {
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
        )) as Array<[string, Array<[string, string[]]>]> | null;
        if (!res) continue;
        for (const [, entries] of res) for (const [id, fields] of entries) await handle(id, fields);
      } catch (err) {
        if (!running) return;
        logger.error(`engine: read failed: ${(err as Error).message}`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  };

  return {
    async start() {
      if (running) return;
      rules = createRuleCache(opts.store, { logger });
      directory = createDirectory(opts.store, { logger });
      await Promise.all([rules.ready, directory.ready]);
      try {
        await opts.redis.xgroup("CREATE", STREAM_EVENTS, GROUP_ENGINE, "$", "MKSTREAM");
      } catch (err) {
        if (!String((err as Error).message).includes("BUSYGROUP")) throw err;
      }
      reader = opts.redis.duplicate();
      running = true;
      loop = run();
    },
    async stop() {
      running = false;
      reader?.disconnect();
      await loop;
      rules?.close();
      directory?.close();
      reader = undefined;
      loop = undefined;
    },
  };
}
