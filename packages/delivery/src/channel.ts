import type { ChannelId, DeliveryResult, Notification } from "@alerting/shared";

/**
 * Notification as carried on the delivery queue. `approveStepIndex` is a
 * delivery-local extension: when set, ntfy shows an "Approve" action for that
 * runbook step.
 */
export type QueuedNotification = Notification & {
  approveStepIndex?: number;
  /** Delivery-local outage bookkeeping (epoch ms of first "unavailable" failure, and count). */
  outageSince?: number;
  outageCount?: number;
};

/**
 * Result a channel may return. `unavailable: true` means the channel itself is unreachable
 * (network error/timeout, 5xx, 429): retried with backoff without consuming `maxAttempts`,
 * until `maxOutageMs` elapses.
 */
export type ChannelResult = DeliveryResult | { status: "failed"; retryable: true; unavailable: true; error: string };

/** A delivery channel plugin. */
export interface Channel {
  id: ChannelId;
  send(n: QueuedNotification): Promise<ChannelResult>;
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
  async send(n: QueuedNotification): Promise<ChannelResult> {
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
