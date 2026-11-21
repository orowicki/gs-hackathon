import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { HttpIngestRegistry } from "@alerting/ingest";
import { createServer } from "../src/server.js";

let server: ReturnType<typeof createServer> | undefined;

async function start(): Promise<string> {
  server = createServer({ checkPostgres: async () => true, checkRedis: async () => true });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  HttpIngestRegistry.unregister("web");
  await new Promise((r) => (server ? server.close(r) : r(undefined)));
  server = undefined;
});

describe("POST /ingest/:sourceId", () => {
  it("404 for an unknown source", async () => {
    const res = await fetch(`${await start()}/ingest/nope`, { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
  });

  it("202 and emits for a registered source", async () => {
    const got: unknown[] = [];
    HttpIngestRegistry.register("web", async (m) => void got.push(m));
    const res = await fetch(`${await start()}/ingest/web`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: '{"a":1}\n{"a":2}',
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 2 });
    expect(got).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("400 for an empty body", async () => {
    HttpIngestRegistry.register("web", async () => undefined);
    const res = await fetch(`${await start()}/ingest/web`, { method: "POST", body: "  " });
    expect(res.status).toBe(400);
  });
});
