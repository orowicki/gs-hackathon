import RedisMock from "ioredis-mock";
import { Redis } from "ioredis";
import type { QueuedNotification } from "../src/index.js";

export function makeRedis(): Redis {
  const url = process.env.REDIS_URL;
  return (url ? new Redis(url) : new RedisMock()) as unknown as Redis;
}

export function note(i: number | string, over: Partial<QueuedNotification> = {}): QueuedNotification {
  return {
    id: `n${i}`,
    alertId: `a${i}`,
    recipientId: "bob",
    channel: "ntfy",
    severity: "error",
    title: `Title ${i}`,
    clickUrl: `/alerts/a${i}`,
    attempt: 0,
    createdAt: new Date().toISOString(),
    ...over,
  };
}

export async function waitFor(cond: () => Promise<boolean> | boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("waitFor timed out");
}
