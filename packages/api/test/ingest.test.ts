import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { HttpIngestRegistry } from "@alerting/ingest";
import { createServer } from "../src/server.js";

let server: ReturnType<typeof createServer> | undefined;

async function start(): Promise<string> {
  server = createServer({
    checkPostgres: async () => true,
    checkRedis: async () => true,
  });
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
    const res = await fetch(`${await start()}/ingest/nope`, {
      method: "POST",
      body: "{}",
    });
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
    const res = await fetch(`${await start()}/ingest/web`, {
      method: "POST",
      body: "  ",
    });
    expect(res.status).toBe(400);
  });

  /** Send headers only (body never written) and return the status the server answers with. */
  async function headerOnly(
    url: string,
    contentLength: number,
  ): Promise<number> {
    const u = new URL(url);
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: u.hostname,
          port: u.port,
          path: u.pathname,
          method: "POST",
          headers: { "content-length": contentLength },
        },
        (res) => {
          resolve(res.statusCode ?? 0);
          res.resume();
          req.destroy();
        },
      );
      req.on("error", (e) =>
        (e as NodeJS.ErrnoException).code === "ECONNRESET"
          ? undefined
          : reject(e),
      );
      req.flushHeaders();
    });
  }

  it("404 for an unknown source before the body is sent", async () => {
    expect(await headerOnly(`${await start()}/ingest/nope`, 100)).toBe(404);
  });

  it("413 on Content-Length above the limit without reading the body", async () => {
    HttpIngestRegistry.register("web", async () => undefined);
    expect(
      await headerOnly(`${await start()}/ingest/web`, 11 * 1024 * 1024),
    ).toBe(413);
  });

  it("500 with the partial count when emit fails midway", async () => {
    let n = 0;
    HttpIngestRegistry.register("web", async () => {
      if (++n === 2) throw new Error("boom");
    });
    const res = await fetch(`${await start()}/ingest/web`, {
      method: "POST",
      body: "a\nb\nc",
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ accepted: 1, error: "emit failed" });
  });
});
