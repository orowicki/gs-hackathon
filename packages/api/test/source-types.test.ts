import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Deps } from "../src/server.js";

const base: Deps = { checkPostgres: async () => true, checkRedis: async () => true };
let server: Server | undefined;

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise((r) => server?.close(r));
  server = undefined;
});

describe("source-types route", () => {
  it("returns every plugin with its config schema, plus the parser schema", async () => {
    server = createServer(base);
    await new Promise<void>((r) => server!.listen(0, r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const res = await fetch(`${url}/api/source-types`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sourceTypes: { type: string; configSchema: unknown }[];
      parserConfigSchema: unknown;
    };
    expect(body.sourceTypes.map((s) => s.type).sort()).toEqual(["file_tail", "http", "kafka", "redis_stream"]);
    for (const s of body.sourceTypes) expect(typeof s.configSchema).toBe("object");
    expect(typeof body.parserConfigSchema).toBe("object");
    expect(body.parserConfigSchema).not.toBeNull();
  });
});
