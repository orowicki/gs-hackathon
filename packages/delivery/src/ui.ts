import type { Redis } from "ioredis";
import { CHANNEL_UI_PUSH, type Notification } from "@alerting/shared";
import type { Channel } from "./channel.js";

/**
 * Delivery-local addition to the shared UiPush union (relayed by the API SSE endpoint):
 * `{ type: "notification", notification }`.
 */
export type UiNotificationPush = { type: "notification"; notification: Notification };

export function createUiChannel(redis: Pick<Redis, "publish">): Channel {
  return {
    id: "ui",
    async send(n) {
      try {
        const msg: UiNotificationPush = { type: "notification", notification: n };
        await redis.publish(CHANNEL_UI_PUSH, JSON.stringify(msg));
        return { status: "delivered" };
      } catch (e) {
        return { status: "failed", retryable: true, error: `ui publish failed: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
  };
}
