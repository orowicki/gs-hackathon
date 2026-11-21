import type { ChannelId, DeliveryResult, Notification } from "@alerting/shared";

/**
 * Notification as carried on the delivery queue. `approveStepIndex` is a
 * delivery-local extension: when set, ntfy shows an "Approve" action for that
 * runbook step.
 */
export type QueuedNotification = Notification & { approveStepIndex?: number };

/** A delivery channel plugin. */
export interface Channel {
  id: ChannelId;
  send(n: QueuedNotification): Promise<DeliveryResult>;
}

export class ChannelRegistry {
  private readonly channels = new Map<ChannelId, Channel>();

  register(channel: Channel): void {
    this.channels.set(channel.id, channel);
  }
  get(id: ChannelId): Channel | undefined {
    return this.channels.get(id);
  }
  ids(): ChannelId[] {
    return [...this.channels.keys()];
  }
  /** Send via the channel registered for n.channel; unknown channel is a non-retryable failure. */
  async send(n: QueuedNotification): Promise<DeliveryResult> {
    const ch = this.channels.get(n.channel);
    if (!ch) return { status: "failed", retryable: false, error: `unknown channel: ${n.channel}` };
    try {
      return await ch.send(n);
    } catch (e) {
      return { status: "failed", retryable: true, error: e instanceof Error ? e.message : String(e) };
    }
  }
}

/** Process-wide default registry. */
export const defaultRegistry = new ChannelRegistry();
export function registerChannel(channel: Channel): void {
  defaultRegistry.register(channel);
}
export function getChannel(id: ChannelId): Channel | undefined {
  return defaultRegistry.get(id);
}
