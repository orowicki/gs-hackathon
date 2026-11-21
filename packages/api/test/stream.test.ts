import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { Alert, Event } from "@alerting/shared";
import { createServer, type Deps } from "../src/server.js";
import { createMemoryAlertStores } from "../src/routes/alerts/store.js";
import { createUiPushHub } from "../src/stream/sse.js";

const root = new URL("../../../", import.meta.url);
const fx = <T>(p: string): T => JSON.parse(readFileSync(new URL(p, root), "utf8")) as T;
const base: Deps = { checkPostgres: async () => true, checkRedis: async () => true };

let server: http.Server | undefined;
let clients: http.ClientRequest[] = [];
afterEach(async () => {
  for (const c of clients) c.destroy();
  clients = [];
  server?.closeAllConnections();
  await new Promise((r) => server?.close(r));
  server = undefined;
});

const names = ["metric-breach", "trade-rejected", "workflow-failed"];
// Newest first, as the Redis list returns them.
const events: Event[] = names.map((n, i) => {
  const payload = fx<Record<string, unknown>>(`fixtures/events/${n}.json`);
  return { id: n, sourceId: "src", receivedAt: `2026-10-23T09:1${3 - i}:00.000Z`, raw: payload, parsed: payload, schemaId: null, common: {} } as Event;
});

async function start(extra: Partial<Deps> = {}) {
  const hub = createUiPushHub();
  const stores = createMemoryAlertStores();
  const a = { ...fx<Alert>("fixtures/alerts/metric-breach.json"), id: "a1", state: "open" } as Alert;
  await stores.alerts.upsert(a);
  server = createServer({
    ...base,
    alerts: { alerts: stores.alerts, audit: stores.audit, suggestions: stores.suggestions, publish: (p) => hub.publish(JSON.stringify(p)) },
    subscribeUiPush: hub.subscribe,
    recentEvents: async (limit) => events.slice(0, limit),
    ...extra,
  });
  await new Promise<void>((r) => server!.listen(0, r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, hub };
}

function openStream(url: string) {
  let buf = "";
  const waiters: Array<{ s: string; resolve: () => void }> = [];
  const req = http.get(`${url}/api/stream`, (res) => {
    res.setEncoding("utf8");
    res.on("data", (d: string) => {
      buf += d;
      for (const w of [...waiters]) {
        if (!buf.includes(w.s)) continue;
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve();
      }
    });
  });
  req.on("error", () => {});
  clients.push(req);
  const waitFor = (s: string) =>
    new Promise<void>((resolve, reject) => {
      if (buf.includes(s)) return resolve();
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${s}; got ${buf}`)), 3000);
      waiters.push({
        s,
        resolve: () => {
          clearTimeout(t);
          resolve();
        },
      });
    });
  return { req, waitFor, text: () => buf };
}

describe("sse stream", () => {
  it("503 when not configured", async () => {
    server = createServer(base);
    await new Promise<void>((r) => server!.listen(0, r));
    const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/stream`);
    expect(r.status).toBe(503);
  });

  it("sends retry and connected, relays pushes, acks", async () => {
    const { url, hub } = await start();
    const s = openStream(url);
    await s.waitFor(": connected");
    expect(s.text()).toContain("retry: 3000");
    const push = { type: "alert", alertId: "x", kind: "created" };
    hub.publish(JSON.stringify(push));
    await s.waitFor(`data: ${JSON.stringify(push)}\n\n`);
    const r = await fetch(`${url}/api/alerts/a1/ack`, { method: "POST" });
    expect(r.status).toBe(200);
    await s.waitFor(`data: ${JSON.stringify({ type: "alert", alertId: "a1", kind: "acknowledged" })}\n\n`);
  });

  it("503 beyond the connection cap and frees slots on close", async () => {
    const { url, hub } = await start({ sseMaxConnections: 2 });
    const a = openStream(url);
    const b = openStream(url);
    await a.waitFor(": connected");
    await b.waitFor(": connected");
    const over = await fetch(`${url}/api/stream`);
    expect(over.status).toBe(503);
    a.req.destroy();
    for (let i = 0; i < 100 && hub.size > 1; i++) await new Promise((r) => setTimeout(r, 20));
    const c = openStream(url);
    await c.waitFor(": connected");
  });

  it("heartbeats", async () => {
    const { url } = await start({ ssePingMs: 20 });
    const s = openStream(url);
    await s.waitFor(": ping");
  });

  it("unsubscribes on client close", async () => {
    const { url, hub } = await start();
    const s = openStream(url);
    await s.waitFor(": connected");
    expect(hub.size).toBe(1);
    s.req.destroy();
    for (let i = 0; i < 100 && hub.size > 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(hub.size).toBe(0);
  });
});

describe("events routes", () => {
  const post = (url: string, body: unknown) =>
    fetch(`${url}/api/events/test-filter`, { method: "POST", body: JSON.stringify(body) });

  it("recent is newest first and honours limit", async () => {
    const { url } = await start();
    const all = (await (await fetch(`${url}/api/events/recent`)).json()) as Event[];
    expect(all.map((e) => e.id)).toEqual(names);
    const two = (await (await fetch(`${url}/api/events/recent?limit=2`)).json()) as Event[];
    expect(two).toHaveLength(2);
    const clamped = (await (await fetch(`${url}/api/events/recent?limit=0`)).json()) as Event[];
    expect(clamped).toHaveLength(1);
  });

  it("falls through without the dep", async () => {
    const { url } = await start({ recentEvents: undefined });
    expect((await fetch(`${url}/api/events/recent`)).status).toBe(404);
  });

  it("test-filter: null and empty match all", async () => {
    const { url } = await start();
    expect(await (await post(url, { filter: null })).json()).toEqual({ matched: 3, total: 3 });
    expect(await (await post(url, { filter: "" })).json()).toEqual({ matched: 3, total: 3 });
  });

  it("test-filter: text, tree, limit", async () => {
    const { url } = await start();
    const sample = events[0]!.parsed as Record<string, unknown>;
    const key = Object.keys(sample).find((k) => typeof sample[k] === "string")!;
    const val = sample[key];
    expect(typeof val).toBe("string");
    const text = `${key} = ${JSON.stringify(val)}`;
    const t = (await (await post(url, { filter: text })).json()) as { matched: number; total: number };
    expect(t.total).toBe(3);
    expect(t.matched).toBeGreaterThanOrEqual(1);
    const tree = { type: "cmp", field: key, op: "=", value: val };
    const r = await post(url, { filter: tree });
    expect(await r.json()).toEqual(t);
    expect(await (await post(url, { filter: null, limit: 2 })).json()).toEqual({ matched: 2, total: 2 });
  });

  it("test-filter: bad filter is 400, alert.status never matches events", async () => {
    const { url } = await start();
    const bad = await post(url, { filter: "x = " });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toHaveProperty("position");
    expect((await post(url, { filter: { type: "bogus" } })).status).toBe(400);
    const s = await post(url, { filter: 'alert.status = "open"' });
    expect(await s.json()).toEqual({
      matched: 0,
      total: 3,
      warning: "alert.status is not set on events; use alert.sourceStatus",
    });
    const ok = await post(url, { filter: 'alert.sourceStatus = "open"' });
    expect(await ok.json()).not.toHaveProperty("warning");
  });
});
