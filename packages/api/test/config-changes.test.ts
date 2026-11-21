import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { entityId, type ConfigStore, type Kind } from "@alerting/config";
import { createServer } from "../src/server.js";

function memoryStore(): ConfigStore {
  const data = new Map<Kind, Map<string, unknown>>();
  const table = (k: Kind) => data.get(k) ?? data.set(k, new Map()).get(k)!;
  return {
    async list(kind) {
      return [...table(kind).values()] as never;
    },
    async get(kind, id) {
      return table(kind).get(id) as never;
    },
    async upsert(kind, entity) {
      table(kind).set(entityId(kind, entity), structuredClone(entity));
    },
    async delete(kind, id) {
      return table(kind).delete(id);
    },
    async onChange() {
      return () => undefined;
    },
    async close() {},
  };
}

let server: Server | undefined;
async function start(): Promise<string> {
  const config = memoryStore();
  await config.upsert("person", { id: "anna", name: "Anna", role: "lead", canCreateRules: true } as never);
  server = createServer({ checkPostgres: async () => true, checkRedis: async () => true, config });
  await new Promise<void>((r) => server!.listen(0, r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise((r) => server?.close(r));
  server = undefined;
});

const send = (method: string, body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method,
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});
const rule = { id: "r1", name: "R", enabled: true, filter: { type: "cmp", field: "alert.severity", op: "=", value: "critical" }, recipients: [] };
const changes = async (base: string, q = ""): Promise<{ status: number; body: { changes: Record<string, unknown>[] } }> => {
  const r = await fetch(`${base}/api/config/changes${q}`);
  return { status: r.status, body: (await r.json()) as never };
};

describe("config change log", () => {
  it("records the signed-in actor of a write and lists it with the name", async () => {
    const base = await start();
    expect((await fetch(`${base}/api/rules`, send("POST", rule, { "x-account": "anna" }))).status).toBe(201);
    expect((await fetch(`${base}/api/rules/r1`, send("PUT", { ...rule, name: "R2" }))).status).toBe(200);
    const { body } = await changes(base);
    expect(body.changes).toHaveLength(2);
    expect(body.changes[1]).toMatchObject({ kind: "rule", itemId: "r1", action: "create", actor: { id: "anna", name: "Anna" } });
    expect(body.changes[0]).toMatchObject({ action: "update", actor: null });
    expect(typeof body.changes[0]!.occurredAt).toBe("string");
  });

  it("records nothing for refused writes", async () => {
    const base = await start();
    const h = { "x-account": "anna" };
    expect((await fetch(`${base}/api/rules/nope`, send("PUT", { ...rule, id: "nope" }, h))).status).toBe(404);
    expect((await fetch(`${base}/api/rules`, send("POST", { name: "no id" }, h))).status).toBe(400);
    expect((await fetch(`${base}/api/rules/nope`, { method: "DELETE", headers: h })).status).toBe(404);
    expect((await changes(base)).body.changes).toEqual([]);
  });

  it("filters by kind and id and honours limit", async () => {
    const base = await start();
    const h = { "x-account": "anna" };
    await fetch(`${base}/api/rules`, send("POST", rule, h));
    await fetch(`${base}/api/rules`, send("POST", { ...rule, id: "r2" }, h));
    await fetch(`${base}/api/groups`, send("POST", { id: "g1", name: "G", members: [] }, h));
    await fetch(`${base}/api/rules/r2`, { method: "DELETE", headers: h });
    expect((await changes(base, "?kind=rule")).body.changes).toHaveLength(4 - 1);
    expect((await changes(base, "?kind=rule&id=r2")).body.changes.map((c) => c.action)).toEqual(["delete", "create"]);
    expect((await changes(base, "?limit=1")).body.changes).toHaveLength(1);
    expect((await changes(base, "?limit=0")).status).toBe(400);
    expect((await changes(base, "?kind=bogus")).status).toBe(400);
  });

  it("records a starred-filters PUT as a person update by the actor", async () => {
    const base = await start();
    const h = { "x-account": "anna" };
    await fetch(`${base}/api/people`, send("POST", { id: "p1", name: "P", role: "dev" }, h));
    const r = await fetch(`${base}/api/people/p1/starred-filters`, send("PUT", [], h));
    expect(r.status).toBe(200);
    const { body } = await changes(base, "?kind=person&id=p1");
    expect(body.changes[0]).toMatchObject({ kind: "person", itemId: "p1", action: "update", actor: { id: "anna" } });
  });
});
