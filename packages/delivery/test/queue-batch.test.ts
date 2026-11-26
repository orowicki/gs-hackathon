import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Redis } from "ioredis";
import { LIST_DEAD_LETTERS, QUEUE_DELIVERY, QUEUE_DELIVERY_PROCESSING, ZSET_DELIVERY_RETRY } from "@alerting/shared";
import { ChannelRegistry, createDeliveryQueue, type Channel, type DeliveryQueue } from "../src/index.js";
import { makeRedis, note, waitFor } from "./helpers.js";

const WORKERS = `${QUEUE_DELIVERY_PROCESSING}:workers`;
let redis: Redis;
let q: DeliveryQueue | undefined;
beforeEach(async () => {
  redis = makeRedis();
  await redis.del(QUEUE_DELIVERY, QUEUE_DELIVERY_PROCESSING, ZSET_DELIVERY_RETRY, LIST_DEAD_LETTERS, WORKERS);
});
afterEach(async () => {
  await q?.stop();
  q = undefined;
});

const fast = { baseMs: 5, capMs: 20, pollMs: 5, batchSize: 10 };
const reg = (c: Channel): ChannelRegistry => {
  const r = new ChannelRegistry();
  r.register(c);
  return r;
};
async function processingLeft(): Promise<number> {
  let n = await redis.llen(QUEUE_DELIVERY_PROCESSING);
  for (const w of await redis.smembers(WORKERS)) n += await redis.llen(`${QUEUE_DELIVERY_PROCESSING}:${w}`);
  return n;
}

describe("delivery queue batching", () => {
  it("delivers a batch in FIFO order and leaves nothing in processing", async () => {
    const got: string[] = [];
    for (let i = 0; i < 25; i++) await redis.lpush(QUEUE_DELIVERY, JSON.stringify(note(i)));
    q = createDeliveryQueue(redis, { ...fast, registry: reg({ id: "ntfy", send: async (n) => (got.push(n.id), { status: "delivered" }) }) });
    await q.start();
    await waitFor(() => got.length === 25);
    expect(got).toEqual(Array.from({ length: 25 }, (_, i) => `n${i}`));
    await waitFor(async () => (await processingLeft()) === 0);
    await q.stop();
    expect(await processingLeft()).toBe(0);
    expect(await redis.llen(QUEUE_DELIVERY)).toBe(0);
  });

  it("retries a failing retryable send and acks the others", async () => {
    const got: string[] = [];
    for (let i = 0; i < 5; i++) await redis.lpush(QUEUE_DELIVERY, JSON.stringify(note(i)));
    q = createDeliveryQueue(redis, {
      ...fast,
      maxAttempts: 100,
      baseMs: 60_000,
      capMs: 60_000,
      registry: reg({
        id: "ntfy",
        send: async (n) => (n.id === "n2" ? { status: "failed", retryable: true, error: "nope" } : (got.push(n.id), { status: "delivered" })),
      }),
    });
    await q.start();
    await waitFor(async () => (await redis.zcard(ZSET_DELIVERY_RETRY)) === 1 && got.length === 4);
    expect(got).toEqual(["n0", "n1", "n3", "n4"]);
    const [member] = await redis.zrange(ZSET_DELIVERY_RETRY, 0, -1);
    expect(JSON.parse(member as string)).toMatchObject({ id: "n2", attempt: 1 });
    await waitFor(async () => (await processingLeft()) === 0);
  });

  it("dead-letters a corrupt payload inside a batch", async () => {
    const got: string[] = [];
    await redis.lpush(QUEUE_DELIVERY, JSON.stringify(note(1)));
    await redis.lpush(QUEUE_DELIVERY, "{not json");
    await redis.lpush(QUEUE_DELIVERY, JSON.stringify(note(3)));
    q = createDeliveryQueue(redis, { ...fast, registry: reg({ id: "ntfy", send: async (n) => (got.push(n.id), { status: "delivered" }) }) });
    await q.start();
    await waitFor(async () => got.length === 2 && (await redis.llen(LIST_DEAD_LETTERS)) === 1);
    expect(got).toEqual(["n1", "n3"]);
    expect(JSON.parse((await redis.lrange(LIST_DEAD_LETTERS, 0, -1))[0] as string).error).toBe("unparseable payload");
    await waitFor(async () => (await processingLeft()) === 0);
  });
});
