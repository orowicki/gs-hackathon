import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createServer } from "../src/server.js";

let server: ReturnType<typeof createServer>;
let base: string;
beforeAll(async () => {
  server = createServer({
    checkPostgres: async () => true,
    checkRedis: async () => true,
    runbooks: { handle: async () => false },
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

it("unhandled runbook paths fall through to the normal 404", async () => {
  const res = await fetch(`${base}/api/alerts/x`);
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "not found" });
});

it("later routes are still reachable after a runbook miss", async () => {
  const res = await fetch(`${base}/api/dead-letters`);
  expect(res.status).toBe(503);
});
