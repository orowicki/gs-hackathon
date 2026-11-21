import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Redis } from "ioredis";
import {
  CHANNEL_UI_PUSH,
  LIST_DEAD_LETTERS,
  QUEUE_DELIVERY,
  QUEUE_DELIVERY_PROCESSING,
  ZSET_DELIVERY_RETRY,
} from "@alerting/shared";
import { ChannelRegistry, backoffMs, createDeliveryQueue, createUiChannel, type Channel, type DeliveryQueue } from "../src/index.js";
import { makeRedis, note, waitFor } from "./helpers.js";

let redis: Redis;
let q: DeliveryQueue | undefined;
beforeEach(async () => {
  redis = makeRedis();
  await redis.del(QUEUE_DELIVERY, QUEUE_DELIVERY_PROCESSING, ZSET_DELIVERY_RETRY, LIST_DEAD_LETTERS);
});
afterEach(async () => {
  await q?.stop();
  q = undefined;
});

const fast = { baseMs: 5, capMs: 20, pollMs: 5 };
const failing = (retryable: boolean): Channel => ({ id: "ntfy", send: async () => ({ status: "failed", retryable, error: "nope" }) });
const reg = (c: Channel): ChannelRegistry => {
  const r = new ChannelRegistry();
  r.register(c);
  return r;
};

describe("backoff", () => {
  it("is exponential, capped, jittered", () => {
    expect([1, 2, 3, 4].map((a) => backoffMs(a))).toEqual([1000, 2000, 4000, 8000]);
    expect(backoffMs(20)).toBe(60_000);
    expect(backoffMs(3, { baseMs: 10, capMs: 100 })).toBe(40);
    expect(backoffMs(1, { baseMs: 100, jitter: 0.5 }, () => 1)).toBe(50);
  });
});

describe("delivery queue", () => {
  it("delivers and clears processing", async () => {
    const got: string[] = [];
    q = createDeliveryQueue(redis, { ...fast, registry: reg({ id: "ntfy", send: async (n) => (got.push(n.id), { status: "delivered" }) }) });
    await q.start();
    await q.enqueue(note(1));
    await waitFor(() => got.length === 1);
    await waitFor(async () => (await redis.llen(QUEUE_DELIVERY_PROCESSING)) === 0);
  });

  it("dead-letters after maxAttempts and publishes count", async () => {
    const sub = makeRedis();
    const pushes: string[] = [];
    await sub.subscribe(CHANNEL_UI_PUSH);
    sub.on("message", (_c, m) => pushes.push(m));
    q = createDeliveryQueue(redis, { ...fast, maxAttempts: 3, registry: reg(failing(true)) });
    await q.start();
    await q.enqueue(note(1));
    await waitFor(async () => (await q!.listDeadLetters()).length === 1);
    const dl = (await q.listDeadLetters())[0]!;
    expect(dl.id).toBe("n1");
    expect(dl.notification.attempt).toBe(3);
    expect(dl.error).toBe("nope");
    expect(await redis.zcard(ZSET_DELIVERY_RETRY)).toBe(0);
    await waitFor(() => pushes.some((p) => JSON.parse(p).type === "dead_letter"));
    sub.disconnect();
  });

  it("non-retryable goes straight to dead letters; unknown channel too", async () => {
    q = createDeliveryQueue(redis, { ...fast, registry: reg(failing(false)) });
    await q.start();
    await q.enqueue(note(1));
    await q.enqueue(note(2, { channel: "sms" }));
    await waitFor(async () => (await q!.listDeadLetters()).length === 2);
    const dls = await q.listDeadLetters();
    expect(dls.every((d) => d.notification.attempt === 1)).toBe(true);
    expect(dls.find((d) => d.id === "n2")!.error).toContain("unknown channel");
    const st = await q.channelStatus();
    expect(st.find((s) => s.id === "ntfy")).toMatchObject({ healthy: false, deadLetters: 1, pending: 0 });
  });

  it("retryDeadLetter re-enqueues with attempt 0", async () => {
    let ok = false;
    const got: string[] = [];
    q = createDeliveryQueue(redis, {
      ...fast,
      registry: reg({ id: "ntfy", send: async (n) => (ok ? (got.push(n.id), { status: "delivered" }) : { status: "failed", retryable: false, error: "x" }) }),
    });
    await q.start();
    await q.enqueue(note(1));
    await waitFor(async () => (await q!.listDeadLetters()).length === 1);
    ok = true;
    expect(await q.retryDeadLetter("missing")).toBeNull();
    const n = await q.retryDeadLetter("n1");
    expect(n).toMatchObject({ id: "n1", attempt: 0 });
    await waitFor(() => got.length === 1);
    expect(await q.listDeadLetters()).toEqual([]);
  });

  it("recovers processing items on start", async () => {
    await redis.lpush(QUEUE_DELIVERY_PROCESSING, JSON.stringify(note(7)));
    const got: string[] = [];
    q = createDeliveryQueue(redis, { ...fast, registry: reg({ id: "ntfy", send: async (n) => (got.push(n.id), { status: "delivered" }) }) });
    await q.start();
    await waitFor(() => got.includes("n7"));
  });

  it("moveDueRetries moves only due members", async () => {
    q = createDeliveryQueue(redis, { now: () => 1000 });
    await redis.zadd(ZSET_DELIVERY_RETRY, 500, JSON.stringify(note(1)), 5000, JSON.stringify(note(2)));
    expect(await q.moveDueRetries()).toBe(1);
    expect(await redis.llen(QUEUE_DELIVERY)).toBe(1);
    expect(await redis.zcard(ZSET_DELIVERY_RETRY)).toBe(1);
  });
});

describe("ui channel", () => {
  it("publishes notification", async () => {
    const sub = makeRedis();
    const msgs: string[] = [];
    await sub.subscribe(CHANNEL_UI_PUSH);
    sub.on("message", (_c, m) => msgs.push(m));
    const r = await createUiChannel(redis).send(note(1, { channel: "ui" }));
    expect(r).toEqual({ status: "delivered" });
    await waitFor(() => msgs.length === 1);
    expect(JSON.parse(msgs[0]!)).toMatchObject({ type: "notification", notification: { id: "n1" } });
    sub.disconnect();
    const bad = createUiChannel({ publish: () => Promise.reject(new Error("down")) } as never);
    expect(await bad.send(note(1))).toMatchObject({ status: "failed", retryable: true });
  });
});
