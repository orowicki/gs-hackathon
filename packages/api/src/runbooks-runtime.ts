import type pg from "pg";
import type { Redis } from "ioredis";
import { CHANNEL_UI_PUSH, type Alert, type Event, type Notification, type UiPush } from "@alerting/shared";
import type { ConfigStore } from "@alerting/config";
import { compileRule, createDirectory, defaultChannels, routeAlert, type Directory } from "@alerting/engine";
import {
  createApprovalNotifier,
  createDefaultActions,
  createGroupNotifier,
  createPgRunStore,
  createRunbookRegistry,
  createRunner,
  migrateRunbooks,
  type RunStore,
  type RunbookRegistry,
  type Runner,
} from "@alerting/runbooks";
import { createPgAlertStores, createPgEventLoader } from "./routes/alerts/store.js";

export interface RunbookRuntimeOptions {
  pool: pg.Pool;
  /** Used to publish UI pushes when a run changes (best effort). */
  redis: Redis;
  config: Pick<ConfigStore, "get" | "list" | "onChange"> | undefined;
  enqueue(n: Notification): Promise<void>;
  onError?: (err: Error) => void;
}

export interface RunbookRuntime {
  /** Undefined when there is no config store (runbooks cannot be loaded). */
  registry: RunbookRegistry | undefined;
  runner: Runner;
  runStore: RunStore;
  /** Resolves when the runbook tables are migrated. */
  ready: Promise<void>;
  loadAlert(id: string): Promise<Alert | undefined>;
  loadEvent(id: string): Promise<Event | undefined>;
  close(): Promise<void>;
}

/** Builds the runbook runner and its stores; shared by the API process and the runbook worker process. */
export function createRunbookRuntime(o: RunbookRuntimeOptions): RunbookRuntime {
  const onError = o.onError ?? ((err: Error) => console.error("runbook registry:", err.message));
  const ready = migrateRunbooks(o.pool);
  ready.catch((err: unknown) => console.error("runbooks migration failed:", (err as Error).message));
  // The registry shares the config store (and its change events), so runbooks created via /api/runbooks are picked up.
  const registry = o.config ? createRunbookRegistry(o.config, { onError }) : undefined;
  const config = o.config;
  const notifyGroup = createGroupNotifier({
    getGroup: async (id) => (config ? config.get("group", id) : undefined),
    enqueue: (n) => o.enqueue(n),
  });
  const directory: Directory | undefined = config ? createDirectory(config as ConfigStore) : undefined;
  const stores = createPgAlertStores(o.pool);
  const events = createPgEventLoader(o.pool);
  // One audit log: runbook audit entries are written to (and read from) the alerts audit store.
  const runStore = createPgRunStore(o.pool, { ready });

  /** Who to notify for an approval: routed like the alert itself (preferences apply), optionally to the step's approvers group. */
  async function approvalRecipients(alert: Alert, approvers: string | undefined) {
    if (!config || !directory) return [];
    await directory.ready;
    const rule = await config.get("rule", alert.ruleId);
    const event = await events.getEvents([alert.eventId]).then((m) => m.get(alert.eventId));
    if (rule && event) {
      const compiled = compileRule(approvers ? { ...rule, id: `${rule.id}#approvers:${approvers}`, who: [{ recipients: [{ type: "group", id: approvers }] }] } : rule);
      return routeAlert({ alert, event, rule: compiled, directory, now: new Date() }).map((n) => ({
        recipientId: n.recipientId,
        channel: n.channel,
      }));
    }
    // fallback: the approvers group members with the default channels
    const group = approvers ? directory.group(approvers) : undefined;
    return (group?.memberIds ?? []).flatMap((id) => {
      const person = directory.person(id);
      return person ? defaultChannels(person, alert.severity).map((channel) => ({ recipientId: id, channel })) : [];
    });
  }
  const runner = createRunner({
    store: {
      ...runStore,
      appendAudit: (entry) => stores.audit.append(entry),
      listAudit: async ({ alertId, limit } = {}) => {
        const rows = alertId
          ? await stores.audit.listByAlert(alertId)
          : (await stores.audit.list({ limit: limit ?? 100 })).reverse();
        return limit === undefined ? rows : rows.slice(-limit);
      },
    },
    actions: createDefaultActions({ notifyGroup }),
    onAwaitingApproval: createApprovalNotifier({ recipients: approvalRecipients, enqueue: (n) => o.enqueue(n) }),
    onError: (err) => console.error("runbook approval notification:", err.message),
    onUpdate: (run) => {
      const push: UiPush = { type: "alert", alertId: run.alertId, kind: "updated" };
      o.redis.publish(CHANNEL_UI_PUSH, JSON.stringify(push)).catch(() => {
        /* UI push is best effort */
      });
    },
  });
  return {
    registry,
    runner,
    runStore,
    ready,
    loadAlert: async (id) => (await stores.alerts.get(id)) ?? undefined,
    loadEvent: async (id) => (await events.getEvents([id])).get(id),
    close: async () => {
      await registry?.close();
      directory?.close();
    },
  };
}
