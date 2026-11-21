import { randomUUID } from "node:crypto";
import type { Group, Notification } from "@alerting/shared";
import type { NotifyInfo } from "./actions.js";

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
