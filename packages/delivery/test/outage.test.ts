import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  LIST_DEAD_LETTERS,
  QUEUE_DELIVERY,
  QUEUE_DELIVERY_PROCESSING,
  ZSET_DELIVERY_RETRY,
} from "@alerting/shared";
import { ChannelRegistry, createDeliveryQueue, createNtfyChannel, type DeliveryQueue } from "../src/index.js";
import { makeRedis, note, waitFor } from "./helpers.js";

function listen(port: number, received: string[]): Promise<Server> {
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push((JSON.parse(body) as { title: string }).title);
      res.writeHead(200).end("{}");
    });
  });
  return new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(port, "127.0.0.1", () => resolve(srv));
  });
}
const close = (s: Server): Promise<void> => new Promise((r) => s.close(() => r()));

let q: DeliveryQueue | undefined;
afterEach(async () => {
  await q?.stop();
});

describe("ntfy outage (SPEC criterion 8)", () => {
  it("queues during outage and delivers everything after recovery", async () => {
    const N = 20;
    const received: string[] = [];
    // Reserve a free port, then free it so ntfy is "down".
    let srv = await listen(0, received);
    const port = (srv.address() as AddressInfo).port;
    await close(srv);

    const redis = makeRedis();
    await redis.del(QUEUE_DELIVERY, QUEUE_DELIVERY_PROCESSING, ZSET_DELIVERY_RETRY, LIST_DEAD_LETTERS);
    const reg = new ChannelRegistry();
    reg.register(createNtfyChannel({ baseUrl: `http://127.0.0.1:${port}`, publicUrl: "http://app", timeoutMs: 1000 }));
    q = createDeliveryQueue(redis, { registry: reg, baseMs: 20, capMs: 200, pollMs: 10, concurrency: 2 });
    await q.start();
    for (let i = 0; i < N; i++) await q.enqueue(note(i));

    await new Promise((r) => setTimeout(r, 600));
    expect(received).toEqual([]);
    expect(await q.listDeadLetters()).toEqual([]);
    // In-flight items sit in per-worker lists (processing:<workerId>), so count those too,
    // in one MULTI so an item moving between keys is never missed or double-counted.
    const workers = await redis.smembers(`${QUEUE_DELIVERY_PROCESSING}:workers`);
    const m = redis.multi().llen(QUEUE_DELIVERY).llen(QUEUE_DELIVERY_PROCESSING).zcard(ZSET_DELIVERY_RETRY);
    for (const w of workers) m.llen(`${QUEUE_DELIVERY_PROCESSING}:${w}`);
    const held = ((await m.exec()) ?? []).reduce((sum, [err, n]) => {
      if (err) throw err;
      return sum + (n as number);
    }, 0);
    expect(held).toBe(N);

    srv = await listen(port, received);
    try {
      await waitFor(() => new Set(received).size === N, 15_000);
      await waitFor(async () => (await redis.llen(QUEUE_DELIVERY_PROCESSING)) === 0 && (await redis.zcard(ZSET_DELIVERY_RETRY)) === 0);
    } finally {
      await q.stop();
      await close(srv);
    }
    expect(new Set(received)).toEqual(new Set(Array.from({ length: N }, (_, i) => `Title ${i}`)));
    expect(await redis.llen(QUEUE_DELIVERY)).toBe(0);
    expect(await redis.llen(LIST_DEAD_LETTERS)).toBe(0);
  }, 30_000);

  // Real ntfy: NTFY_E2E=1 NTFY_URL=http://localhost:8080 (pairs with `docker compose stop ntfy` / `start ntfy`
  // while this test sleeps); here we only verify delivery to a live server.
  it.skipIf(!(process.env.NTFY_E2E === "1" && process.env.NTFY_URL))("delivers to a real ntfy", async () => {
    const redis = makeRedis();
    const reg = new ChannelRegistry();
    reg.register(createNtfyChannel({ baseUrl: process.env.NTFY_URL!, publicUrl: "http://localhost:3000" }));
    q = createDeliveryQueue(redis, { registry: reg, baseMs: 200, capMs: 2000, maxAttempts: 100, pollMs: 20 });
    await q.start();
    await q.enqueue(note("e2e"));
    await waitFor(async () => (await redis.llen(QUEUE_DELIVERY)) + (await redis.llen(QUEUE_DELIVERY_PROCESSING)) + (await redis.zcard(ZSET_DELIVERY_RETRY)) === 0, 60_000);
  }, 70_000);
});
