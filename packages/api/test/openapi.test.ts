import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ROUTES } from "@alerting/shared";
import { buildOpenApi } from "../src/openapi.js";
import { createServer } from "../src/server.js";

let server: ReturnType<typeof createServer> | undefined;
afterEach(async () => {
  await new Promise((r) => (server ? server.close(r) : r(undefined)));
  server = undefined;
});

describe("OpenAPI", () => {
  it("is 3.1 and contains every ROUTES entry with unique operationIds", () => {
    const doc = buildOpenApi() as {
      openapi: string;
      paths: Record<string, Record<string, { operationId: string }>>;
    };
    expect(doc.openapi).toBe("3.1.0");
    const ids = new Set<string>();
    for (const r of ROUTES) {
      const op = doc.paths[r.path]?.[r.method.toLowerCase()];
      expect(op, `${r.method} ${r.path}`).toBeDefined();
      ids.add(op!.operationId);
    }
    expect(ids.size).toBe(ROUTES.length);
  });

  it("has no duplicate method+path in ROUTES", () => {
    expect(new Set(ROUTES.map((r) => `${r.method} ${r.path}`)).size).toBe(ROUTES.length);
  });

  it("is served at GET /api/openapi.json", async () => {
    server = createServer({ checkPostgres: async () => true, checkRedis: async () => true });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/openapi.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(((await res.json()) as { openapi: string }).openapi).toBe("3.1.0");
  });
});
