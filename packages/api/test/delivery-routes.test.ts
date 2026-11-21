import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { DeadLetter, Notification } from "@alerting/shared";
import { createServer, type Deps } from "../src/server.js";

const base: Deps = { checkPostgres: async () => true, checkRedis: async () => true };
let server: Server | undefined;

async function start(deps: Partial<Deps>): Promise<string> {
  server = createServer({ ...base, ...deps });
  await new Promise<void>((r) => server!.listen(0, r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise((r) => server?.close(r));
  server = undefined;
});

const note = { id: "n/1" } as unknown as Notification;
const dl = [{ id: "n/1", notification: note, error: "x", failedAt: "t" }] as unknown as DeadLetter[];
const delivery = {
  listDeadLetters: async () => dl,
  retryDeadLetter: async (id: string) => (id === "n/1" ? note : null),
  channelStatus: async () => [{ channel: "ntfy", healthy: true }] as never,
};

describe("delivery routes", () => {
  it("lists dead letters, retries, 404s, channels", async () => {
    const url = await start({ delivery });
    expect(await (await fetch(`${url}/api/dead-letters`)).json()).toEqual(dl);
    const ok = await fetch(`${url}/api/dead-letters/${encodeURIComponent("n/1")}/retry`, { method: "POST" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual(note);
    const nf = await fetch(`${url}/api/dead-letters/nope/retry`, { method: "POST" });
    expect(nf.status).toBe(404);
    expect(await nf.json()).toHaveProperty("error");
    expect(await (await fetch(`${url}/api/channels`)).json()).toEqual([{ channel: "ntfy", healthy: true }]);
  });

  it("returns 503 without deps", async () => {
    const url = await start({});
    for (const [m, p] of [["GET", "/api/dead-letters"], ["POST", "/api/dead-letters/a/retry"], ["GET", "/api/channels"], ["GET", "/api/stream"]]) {
      const r = await fetch(url + p, { method: m });
      expect(r.status).toBe(503);
      expect(await r.json()).toEqual({ error: "delivery not configured" });
    }
  });

  it("streams pushed messages over SSE and unsubscribes on close", async () => {
    let push: ((j: string) => void) | undefined;
    let unsubscribed = false;
    const url = await start({
      subscribeUiPush(cb) {
        push = cb;
        return () => {
          unsubscribed = true;
        };
      },
    });
    const ac = new AbortController();
    const res = await fetch(`${url}/api/stream`, { signal: ac.signal });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    push!('{"type":"x"}');
    const reader = res.body!.getReader();
    let text = "";
    while (!text.includes('data: {"type":"x"}\n\n')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    expect(text).toContain('data: {"type":"x"}\n\n');
    ac.abort();
    for (let i = 0; i < 50 && !unsubscribed; i++) await new Promise((r) => setTimeout(r, 20));
    expect(unsubscribed).toBe(true);
  });
});
