import { randomUUID } from "node:crypto";
import type { Alert, Group, Notification } from "@alerting/shared";
import { stepDisplayName, type NotifyInfo } from "./actions.js";
import type { StoredRun } from "./store.js";

export interface GroupNotifierOptions {
  getGroup(id: string): Promise<Group | undefined>;
  enqueue(n: Notification): Promise<void>;
  channels?: string[];
  newId?: () => string;
  now?: () => Date;
}

/** Builds the `notifyGroup` callback of the escalate action. */
export function createGroupNotifier(opts: GroupNotifierOptions): (groupId: string, info: NotifyInfo) => Promise<string> {
  const channels = opts.channels ?? ["ntfy"];
  const newId = opts.newId ?? randomUUID;
  const now = opts.now ?? (() => new Date());
  return async (groupId, info) => {
    const group = await opts.getGroup(groupId);
    if (!group) throw new Error(`group ${groupId} not found`);
    const alert = info.template.alert;
    const members = [...new Set(group.memberIds)];
    for (const recipientId of members) {
      for (const channel of channels) {
        await opts.enqueue({
          id: newId(),
          alertId: info.alertId,
          recipientId,
          channel,
          severity: alert?.severity ?? "warning",
          title: alert?.title ?? `Alert ${info.alertId}`,
          body: alert?.body,
          clickUrl: `/alerts/${info.alertId}`,
          attempt: 0,
          createdAt: now().toISOString(),
        });
      }
    }
    return `notified group ${groupId} (${members.length} people)`;
  };
}

/** Notification with the ntfy Approve button (DeliveryNotification.approveStepIndex); serialized through the queue as JSON. */
export type ApprovalNotification = Notification & { approveStepIndex: number };

export interface ApprovalNotifierOptions {
  /** Resolves who to notify; approversGroupId is the step's `approvers` (undefined: the alert's own recipients). */
  recipients(alert: Alert, approversGroupId: string | undefined): Promise<Array<{ recipientId: string; channel: string }>>;
  enqueue(n: ApprovalNotification): Promise<void>;
  now?: () => Date;
}

/** Builds the runner's `onAwaitingApproval` callback: one notification per recipient and channel. */
export function createApprovalNotifier(opts: ApprovalNotifierOptions): (run: StoredRun, stepIndex: number) => Promise<void> {
  const now = opts.now ?? (() => new Date());
  return async (run, stepIndex) => {
    const alert = run.template.alert;
    const step = run.runbook.steps[stepIndex];
    if (!alert || !step) return;
    const stepName = stepDisplayName(step, run.template);
    const targets = await opts.recipients(alert, step.approvers);
    const seen = new Set<string>();
    for (const t of targets) {
      const key = `${t.recipientId}\u0000${t.channel}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await opts.enqueue({
        id: `approval:${alert.id}:${run.runbookId}:${stepIndex}:${t.recipientId}:${t.channel}`,
        alertId: alert.id,
        recipientId: t.recipientId,
        channel: t.channel,
        severity: alert.severity,
        title: `Approval needed: ${stepName} (${alert.title})`,
        body: `Runbook "${run.runbook.name}" waits for approval of step ${stepIndex + 1}: ${stepName}`,
        clickUrl: `/alerts/${alert.id}`,
        approveStepIndex: stepIndex,
        attempt: 0,
        createdAt: now().toISOString(),
      });
    }
  };
}
