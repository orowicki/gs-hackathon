import type { ChannelId, Id, IsoTimestamp, Severity } from "./common.js";

/** One message to one recipient on one channel. Payload of the delivery queue. */
export interface Notification {
  id: Id;
  alertId: Id;
  recipientId: Id;
  channel: ChannelId;
  severity: Severity;
  title: string;
  body?: string;
  /** Link to /alerts/{id}. */
  clickUrl: string;
  /** Runbook link (text runbooks) shown in ntfy. */
  runbookUrl?: string;
  /** Digest bundles several alerts into one notification. */
  digestAlertIds?: Id[];
  attempt: number;
  createdAt: IsoTimestamp;
  /** Epoch ms when the next retry is due. */
  nextAttemptAt?: number;
}

export type DeliveryResult =
  | { status: "delivered" }
  | { status: "failed"; retryable: boolean; error: string };

export interface DeadLetter {
  /** Id used by /api/dead-letters/{id}/retry; equals notification.id. */
  id: Id;
  notification: Notification;
  error: string;
  failedAt: IsoTimestamp;
}

export interface ChannelStatus {
  id: ChannelId;
  healthy: boolean;
  pending: number;
  deadLetters: number;
  lastError?: string;
}
