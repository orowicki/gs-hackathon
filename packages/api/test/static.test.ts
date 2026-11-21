import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";

let server: ReturnType<typeof createServer>;
let base: string;
let dir: string;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "web-dist-"));
  fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>app</title>");
  fs.mkdirSync(path.join(dir, "assets"));
  fs.writeFileSync(path.join(dir, "assets", "a.js"), "console.log(1)");
  server = createServer({ checkPostgres: async () => true, checkRedis: async () => true, webDist: dir });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("static web serving", () => {
  it("serves index.html for /", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("<title>app</title>");
  });

  it("serves assets with the right content type", async () => {
    const res = await fetch(`${base}/assets/a.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
  });

  it("falls back to index.html for SPA routes", async () => {
    const res = await fetch(`${base}/alerts/42`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>app</title>");
  });

  it("blocks path traversal", async () => {
    for (const p of ["/../package.json", "/%2e%2e/package.json", "/..%2f..%2fpackage.json"]) {
      const res = await fetch(`${base}${p}`);
      expect(res.status).toBe(404);
    }
  });

  it("returns 404 JSON for /api paths and missing files", async () => {
    const res = await fetch(`${base}/api/x`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
    expect((await fetch(`${base}/missing.js`)).status).toBe(404);
  });
});
