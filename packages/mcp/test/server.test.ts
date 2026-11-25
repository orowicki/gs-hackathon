import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { TOOLS } from "../src/tools.js";

interface Seen {
  method: string;
  path: string;
  body: unknown;
}
let seen: Seen[] = [];
let api: http.Server;
let client: Client;

beforeAll(async () => {
  api = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString();
      seen.push({ method: req.method ?? "", path: req.url ?? "", body: text ? JSON.parse(text) : undefined });
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/filters/parse" && text.includes("bad")) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "unexpected token at position 5", position: 5 }));
        return;
      }
      if (req.url === "/api/alerts" || req.url?.startsWith("/api/alerts?")) {
        res.setHeader("x-next-before", "cur123");
        res.setHeader("x-next-offset", "30");
        res.end(JSON.stringify([{ id: "a1" }]));
        return;
      }
      if (req.url === "/api/alerts/conflict/ack") {
        res.statusCode = 409;
        res.end(JSON.stringify({ error: "cannot acknowledge an alert in this state", state: "resolved" }));
        return;
      }
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer({ baseUrl }).connect(a);
  client = new Client({ name: "test", version: "0" });
  await client.connect(b);
});
afterAll(async () => {
  await client.close();
  await new Promise((r) => api.close(r));
});

const source = { id: "s1", name: "S", enabled: true, parser: { type: "json" }, type: "http", config: {} };
const schema = { id: "sc1", name: "Sc", match: "alert.source = s1", mapping: { title: { kind: "path", path: "msg" } } };
const rule = {
  id: "r1",
  name: "R",
  enabled: true,
  when: "alert.severity = critical",
  who: [{ recipients: [{ type: "group", id: "g1" }] }],
  looks: { titleTemplate: "{{title}}", fields: [] },
};

const cases: [string, Record<string, unknown>, Seen][] = [
  ["list_sources", {}, { method: "GET", path: "/api/sources", body: undefined }],
  ["get_source", { id: "a b" }, { method: "GET", path: "/api/sources/a%20b", body: undefined }],
  ["create_source", source, { method: "POST", path: "/api/sources", body: source }],
  ["update_source", source, { method: "PUT", path: "/api/sources/s1", body: source }],
  ["delete_source", { id: "s1" }, { method: "DELETE", path: "/api/sources/s1", body: undefined }],
  ["list_schemas", {}, { method: "GET", path: "/api/schemas", body: undefined }],
  ["get_schema", { id: "sc1" }, { method: "GET", path: "/api/schemas/sc1", body: undefined }],
  ["create_schema", schema, { method: "POST", path: "/api/schemas", body: schema }],
  ["update_schema", schema, { method: "PUT", path: "/api/schemas/sc1", body: schema }],
  ["delete_schema", { id: "sc1" }, { method: "DELETE", path: "/api/schemas/sc1", body: undefined }],
  ["list_rules", {}, { method: "GET", path: "/api/rules", body: undefined }],
  ["get_rule", { id: "r1" }, { method: "GET", path: "/api/rules/r1", body: undefined }],
  ["create_rule", rule, { method: "POST", path: "/api/rules", body: rule }],
  ["update_rule", rule, { method: "PUT", path: "/api/rules/r1", body: rule }],
  ["delete_rule", { id: "r1" }, { method: "DELETE", path: "/api/rules/r1", body: undefined }],
  ["validate_filter", { text: "alert.severity = info" }, { method: "POST", path: "/api/filters/parse", body: { text: "alert.severity = info" } }],
  ["list_recent_events", { limit: 5 }, { method: "GET", path: "/api/events/recent?limit=5", body: undefined }],
  [
    "list_alerts",
    { filter: "alert.severity = critical", state: "open", limit: 10, sort: "severity", order: "asc", offset: 20 },
    {
      method: "GET",
      path: "/api/alerts?" + new URLSearchParams({ filter: "alert.severity = critical", state: "open", limit: "10", sort: "severity", order: "asc", offset: "20" }).toString(),
      body: undefined,
    },
  ],
  ["get_source", { id: "a/b" }, { method: "GET", path: "/api/sources/a%2Fb", body: undefined }],
  ["acknowledge_alert", { id: "a1", actor: "anna" }, { method: "POST", path: "/api/alerts/a1/ack", body: { actor: "anna" } }],
  ["resolve_alert", { id: "a1", actor: "anna" }, { method: "POST", path: "/api/alerts/a1/resolve", body: { actor: "anna" } }],
  ["acknowledge_alert", { id: "a1" }, { method: "POST", path: "/api/alerts/a1/ack", body: undefined }],
  ["resolve_alert", { id: "a1" }, { method: "POST", path: "/api/alerts/a1/resolve", body: undefined }],
];

describe("mcp server", () => {
  it("lists all tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(TOOLS.map((t) => t.name).sort());
    expect(tools).toHaveLength(20);
  });

  it.each(cases)("%s calls the API", async (name, args, expected) => {
    seen = [];
    const res = await client.callTool({ name, arguments: args });
    expect(res.isError).toBeFalsy();
    expect(seen).toEqual([expected]);
    if (name !== "list_alerts") expect((res.content as { text: string }[])[0]?.text).toBe('{"ok":true}');
  });

  it("turns an API 4xx into a tool error with the API message", async () => {
    const res = await client.callTool({ name: "validate_filter", arguments: { text: "bad ((" } });
    expect(res.isError).toBe(true);
    const text = (res.content as { text: string }[])[0]?.text;
    expect(text).toContain("unexpected token");
    expect(text).toContain("400");
    expect(text?.match(/position/g)).toHaveLength(1);
  });

  it("surfaces extra error fields such as state", async () => {
    const res = await client.callTool({ name: "acknowledge_alert", arguments: { id: "conflict" } });
    expect(res.isError).toBe(true);
    const text = (res.content as { text: string }[])[0]?.text;
    expect(text).toContain("409");
    expect(text).toContain("state: resolved");
  });

  it("passes unknown entity keys through", async () => {
    seen = [];
    const withExtra = { ...rule, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z" };
    await client.callTool({ name: "update_rule", arguments: withExtra });
    expect(seen[0]?.body).toEqual(withExtra);
  });

  it("exposes groupBy and groupWindow on the rule tools and sends them", async () => {
    const { tools } = await client.listTools();
    for (const name of ["create_rule", "update_rule"]) {
      const props = (tools.find((t) => t.name === name)?.inputSchema.properties ?? {}) as Record<string, { type?: string; description?: string }>;
      expect(props.groupBy?.type).toBe("array");
      expect(props.groupBy?.description).toBeTruthy();
      expect(props.groupWindow?.description).toBeTruthy();
    }
    seen = [];
    const grouped = { ...rule, groupBy: ["source", "environment"], groupWindow: "5m" };
    const res = await client.callTool({ name: "create_rule", arguments: grouped });
    expect(res.isError).toBeFalsy();
    expect(seen[0]?.body).toEqual(grouped);
  });

  it("returns paging cursors from list_alerts", async () => {
    const res = await client.callTool({ name: "list_alerts", arguments: {} });
    expect(JSON.parse((res.content as { text: string }[])[0]!.text)).toEqual({
      items: [{ id: "a1" }],
      nextBefore: "cur123",
      nextOffset: 30,
    });
  });
});
