import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";

let server: ReturnType<typeof createServer> | undefined;

async function start(redis: boolean): Promise<string> {
  server = createServer({
    checkPostgres: async () => true,
    checkRedis: async () => redis,
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await new Promise((r) => (server ? server.close(r) : r(undefined)));
  server = undefined;
});

describe("GET /health", () => {
  it("returns 200 when all checks pass", async () => {
    const res = await fetch(`${await start(true)}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, checks: { postgres: true, redis: true } });
  });

  it("returns 503 when redis fails", async () => {
    const res = await fetch(`${await start(false)}/health`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, checks: { postgres: true, redis: false } });
  });

  it("returns 404 JSON for unknown routes", async () => {
    const res = await fetch(`${await start(true)}/nope`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });
});
