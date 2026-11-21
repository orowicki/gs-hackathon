import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";

const root = new URL("../../../", import.meta.url);
const fx = <T>(p: string): T => JSON.parse(readFileSync(new URL(p, root), "utf8")) as T;

let server: http.Server | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise((r) => server?.close(r));
  server = undefined;
});

async function post(path: string, body: unknown, raw = false) {
  server ??= createServer({ checkPostgres: async () => true, checkRedis: async () => true });
  if (!server.listening) await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw ? (body as string) : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const event = fx<Record<string, unknown>>("fixtures/events/workflow-failed.json");
const schema = {
  id: "wf",
  name: "Workflow",
  match: "event.workflow = \"__none__\"",
  mapping: { title: { kind: "constant", value: "T" }, severity: { kind: "constant", value: "critical" } },
};

describe("POST /api/sources/test", () => {
  it("rejects an oversized sample", async () => {
    const r = await post("/api/sources/test", { parser: { type: "json" }, sample: "x".repeat(8193) });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("sample too long");
  });

  it("json", async () => {
    const r = await post("/api/sources/test", { parser: { type: "json" }, sample: JSON.stringify(event) });
    expect(r.status).toBe(200);
    expect(r.json.parsed).toEqual(event);
  });
  it("logfmt", async () => {
    const r = await post("/api/sources/test", { parser: { type: "logfmt" }, sample: 'level=error msg="payment failed"' });
    expect(r.json.parsed).toEqual({ level: "error", msg: "payment failed" });
  });
  it("regex", async () => {
    const r = await post("/api/sources/test", { parser: { type: "regex", pattern: "(?<lvl>\\w+): (?<m>.*)" }, sample: "ERROR: boom" });
    expect(r.status).toBe(200);
    expect(r.json.parsed).toMatchObject({ lvl: "ERROR", m: "boom" });
  });
  it("raw", async () => {
    const r = await post("/api/sources/test", { parser: { type: "raw" }, sample: "hello" });
    expect(r.json.parsed).toEqual({ raw: "hello" });
  });
  it("400s", async () => {
    expect((await post("/api/sources/test", { parser: { type: "regex", pattern: "(" }, sample: "x" })).status).toBe(400);
    expect((await post("/api/sources/test", { parser: { type: "json" } })).status).toBe(400);
    expect((await post("/api/sources/test", { parser: { type: "nope" }, sample: "x" })).status).toBe(400);
    const r = await post("/api/sources/test", "not json", true);
    expect(r.status).toBe(400);
    expect(typeof r.json.error).toBe("string");
  });
});

describe("POST /api/schemas/test", () => {
  it("matched true with common fields", async () => {
    const r = await post("/api/schemas/test", { schema: { ...schema, match: "" }, sample: event });
    expect(r.status).toBe(200);
    expect(r.json.matched).toBe(true);
    expect(r.json.common).toMatchObject({ title: "T", severity: "critical" });
  });
  it("matched false", async () => {
    const r = await post("/api/schemas/test", { schema, sample: event });
    expect(r.status).toBe(200);
    expect(r.json.matched).toBe(false);
    expect(r.json.common).toBeTypeOf("object");
  });
  it("invalid schema / sample -> 400", async () => {
    const bad = await post("/api/schemas/test", { schema: { ...schema, match: "((" }, sample: event });
    expect(bad.status).toBe(400);
    expect(bad.json.position).toBeTypeOf("number");
    expect((await post("/api/schemas/test", { schema: { id: "x" }, sample: event })).status).toBe(400);
    expect((await post("/api/schemas/test", { schema, sample: "str" })).status).toBe(400);
    expect((await post("/api/schemas/test", "{", true)).status).toBe(400);
  });
});
