import http from "node:http";
import type { AddressInfo } from "node:net";
import { Redis } from "ioredis";
import { afterEach, describe, expect, it } from "vitest";
import type { RawMessage, Source } from "@alerting/shared";
import { createServer, type Deps } from "../src/server.js";
import { createRedisPreview, type PreviewDeps } from "../src/routes/preview.routes.js";

const base: Deps = { checkPostgres: async () => true, checkRedis: async () => true };
const source = { id: "s1", name: "s1", type: "http", enabled: true, config: {}, parser: { type: "json" } } as unknown as Source;

let server: http.Server | undefined;
let clients: http.ClientRequest[] = [];
afterEach(async () => {
  for (const c of clients) c.destroy();
  clients = [];
  server?.closeAllConnections();
  if (server) await new Promise((r) => server!.close(r));
  server = undefined;
});

async function start(preview: PreviewDeps | undefined, extra: Partial<Deps> = {}) {
  server = createServer({ ...base, preview, ...extra });
  await new Promise<void>((r) => server!.listen(0, r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function open(url: string, p = "/api/sources/s1/preview") {
  let buf = "";
  let headers: http.IncomingHttpHeaders = {};
  let status = 0;
  const waiters: Array<() => void> = [];
  const req = http.get(url + p, (res) => {
    status = res.statusCode ?? 0;
    headers = res.headers;
    res.setEncoding("utf8");
    res.on("data", (d: string) => {
      buf += d;
      waiters.forEach((w) => w());
    });
    waiters.forEach((w) => w());
  });
  req.on("error", () => {});
  clients.push(req);
  const until = (pred: () => boolean) =>
    new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout; got ${buf}`)), 3000);
      const check = () => {
        if (!pred()) return;
        clearTimeout(t);
        resolve();
      };
      waiters.push(check);
      check();
    });
  return { req, until, get buf() { return buf; }, get status() { return status; }, get headers() { return headers; } };
}

function fake() {
  const state = { push: undefined as undefined | ((m: RawMessage) => void), aborted: false, ended: false };
  const preview: PreviewDeps = {
    getSource: async (id) => (id === "s1" ? source : null),
    tail: (_id, onMessage, signal) =>
      new Promise<void>((resolve) => {
        state.push = onMessage;
        signal.addEventListener("abort", () => {
          state.aborted = true;
          resolve();
        });
      }).then(() => void (state.ended = true)),
  };
  return { state, preview };
}

describe("GET /api/sources/{id}/preview", () => {
  it("404 for an unknown source", async () => {
    const url = await start(fake().preview);
    const c = open(url, "/api/sources/nope/preview");
    await c.until(() => c.status === 404);
  });

  it("503 when preview is not configured", async () => {
    const url = await start(undefined);
    const c = open(url);
    await c.until(() => c.status === 503);
  });

  it("503 beyond the connection cap", async () => {
    const url = await start(fake().preview, { previewMaxConnections: 1 });
    const a = open(url);
    await a.until(() => a.status === 200);
    const b = open(url);
    await b.until(() => b.status === 503);
  });

  it("streams raw and parsed messages as SSE and aborts on disconnect", async () => {
    const { state, preview } = fake();
    const url = await start(preview);
    const c = open(url);
    await c.until(() => c.status === 200 && state.push !== undefined);
    expect(c.headers["content-type"]).toBe("text/event-stream");
    state.push!({ sourceId: "s1", receivedAt: "2026-01-01T00:00:00.000Z", raw: '{"a":1}' });
    await c.until(() => c.buf.includes("\n\ndata: "));
    const line = c.buf.split("\n").find((l) => l.startsWith("data: "))!;
    expect(JSON.parse(line.slice(6))).toEqual({ receivedAt: "2026-01-01T00:00:00.000Z", raw: '{"a":1}', parsed: { a: 1 } });
    c.req.destroy();
    for (let i = 0; i < 50 && !state.ended; i++) await new Promise((r) => setTimeout(r, 20));
    expect(state.aborted).toBe(true);
    expect(state.ended).toBe(true);
  });
});

describe.skipIf(!process.env.REDIS_URL)("createRedisPreview (real Redis)", () => {
  it("delivers only the source's messages and closes its connection on abort", async () => {
    const redis = new Redis(process.env.REDIS_URL!);
    const stream = `test:preview:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const dups: Redis[] = [];
    const spy = { duplicate: () => { const d = redis.duplicate(); dups.push(d); return d; } };
    const p = createRedisPreview({ redis: spy, config: { get: async () => source }, stream, blockMs: 500 });
    const got: RawMessage[] = [];
    const ac = new AbortController();
    const add = (sourceId: string, raw: string) =>
      redis.xadd(stream, "*", "data", JSON.stringify({ sourceId, receivedAt: new Date().toISOString(), raw }));
    const done = Promise.resolve(p.tail("s1", (m) => got.push(m), ac.signal));
    try {
      // Re-send until the tail is attached (it only sees entries added after it started).
      for (let i = 0; i < 100 && got.length === 0; i++) {
        await add("other", '{"x":0}');
        await add("s1", '{"a":1}');
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(got.length).toBeGreaterThan(0);
      expect(got.every((m) => m.sourceId === "s1" && m.raw === '{"a":1}')).toBe(true);
      ac.abort();
      await done;
      expect(dups).toHaveLength(1);
      expect(dups[0]!.status).toBe("end");
    } finally {
      ac.abort();
      await redis.del(stream);
      redis.disconnect();
    }
  });
});
