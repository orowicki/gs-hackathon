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
async function start(): Promise<{ base: string; config: ConfigStore }> {
  const config = memoryStore();
  await config.upsert("person", { id: "anna", name: "Anna", role: "lead", canCreateRules: true } as never);
  await config.upsert("person", { id: "ewa", name: "Ewa", role: "eng", canCreateRules: false } as never);
  server = createServer({ checkPostgres: async () => true, checkRedis: async () => true, config });
  await new Promise<void>((r) => server!.listen(0, r));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, config };
}
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise((r) => server?.close(r));
  server = undefined;
});

const post = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});
const rule = { id: "r1", name: "R", enabled: true, filter: { type: "cmp", field: "alert.severity", op: "=", value: "critical" }, recipients: [] };

describe("accounts and sessions", () => {
  it("creates an account as a person without rule permission", async () => {
    const { base, config } = await start();
    const r = await fetch(`${base}/api/accounts`, post({ name: "Piotr" }));
    expect(r.status).toBe(201);
    const p = (await r.json()) as { id: string; canCreateRules: boolean };
    expect(p.canCreateRules).toBe(false);
    expect(await config.get("person", p.id)).toBeDefined();
  });

  it("signs in, reads the session by cookie and by X-Account, and signs out", async () => {
    const { base } = await start();
    expect((await fetch(`${base}/api/session`)).status).toBe(401);
    const r = await fetch(`${base}/api/session`, post({ personId: "anna" }));
    expect(r.status).toBe(200);
    const setCookie = r.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    expect(setCookie).toMatch(/Path=\//);
    const cookie = setCookie.split(";")[0]!;
    const me = await fetch(`${base}/api/session`, { headers: { cookie } });
    expect(((await me.json()) as { id: string }).id).toBe("anna");
    const viaHeader = await fetch(`${base}/api/session`, { headers: { "x-account": "ewa" } });
    expect(((await viaHeader.json()) as { id: string }).id).toBe("ewa");
    expect((await fetch(`${base}/api/session`, { method: "DELETE", headers: { cookie } })).status).toBe(204);
    expect((await fetch(`${base}/api/session`, { headers: { cookie } })).status).toBe(401);
  });

  it("404 for an unknown person", async () => {
    const { base } = await start();
    const r = await fetch(`${base}/api/session`, post({ personId: "nobody" }));
    expect(r.status).toBe(404);
    expect(await r.json()).toHaveProperty("error");
  });

  it("403 on rule create/edit without canCreateRules, allowed with it or with no account", async () => {
    const { base } = await start();
    const denied = await fetch(`${base}/api/rules`, post(rule, { "x-account": "ewa" }));
    expect(denied.status).toBe(403);
    const put = await fetch(`${base}/api/rules/r1`, { ...post(rule, { "x-account": "ewa" }), method: "PUT" });
    expect(put.status).toBe(403);
    const login = await fetch(`${base}/api/session`, post({ personId: "ewa" }));
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    expect((await fetch(`${base}/api/rules`, post(rule, { cookie }))).status).toBe(403);
    expect((await fetch(`${base}/api/rules`, post(rule, { "x-account": "anna" }))).status).toBe(201);
    expect((await fetch(`${base}/api/rules`, post({ ...rule, id: "r2" }))).status).toBe(201);
  });

  it("403 when an account without canCreateRules grants or changes canCreateRules", async () => {
    const { base } = await start();
    const h = { "x-account": "ewa" };
    const person = { id: "x1", name: "X", role: "r", canCreateRules: true };
    expect((await fetch(`${base}/api/people`, post(person, h))).status).toBe(403);
    const self = { id: "ewa", name: "Ewa", role: "eng", canCreateRules: true };
    expect((await fetch(`${base}/api/people/ewa`, { ...post(self, h), method: "PUT" })).status).toBe(403);
    // Without canCreateRules no one can add people at all (only edit their own person).
    expect((await fetch(`${base}/api/people`, post({ ...person, canCreateRules: false }, h))).status).toBe(403);
    expect((await fetch(`${base}/api/people/ewa`, { ...post({ ...self, canCreateRules: false, role: "x" }, h), method: "PUT" })).status).toBe(200);
    expect((await fetch(`${base}/api/people`, post({ ...person, id: "x2" }, { "x-account": "anna" }))).status).toBe(201);
  });

  it("403 on people and group writes and on deletes without canCreateRules; own person may be edited", async () => {
    const { base, config } = await start();
    await config.upsert("group", { id: "g1", name: "G", memberIds: ["anna"] } as never);
    await config.upsert("rule", { ...rule } as never);
    const ewa = { "x-account": "ewa" };
    const anna = { "x-account": "anna" };
    const put = (body: unknown, headers: Record<string, string>): RequestInit => ({ ...post(body, headers), method: "PUT" });
    const del = (headers: Record<string, string>): RequestInit => ({ method: "DELETE", headers });
    const group = { id: "g1", name: "G2", memberIds: ["anna", "ewa"] };

    expect((await fetch(`${base}/api/groups`, post({ ...group, id: "g2" }, ewa))).status).toBe(403);
    expect((await fetch(`${base}/api/groups/g1`, put(group, ewa))).status).toBe(403);
    expect((await fetch(`${base}/api/groups/g1`, del(ewa))).status).toBe(403);
    expect((await fetch(`${base}/api/people/anna`, put({ id: "anna", name: "A", role: "lead", canCreateRules: true }, ewa))).status).toBe(403);
    expect((await fetch(`${base}/api/people/anna`, del(ewa))).status).toBe(403);
    expect((await fetch(`${base}/api/people/ewa`, del(ewa))).status).toBe(403);
    expect((await fetch(`${base}/api/rules/r1`, del(ewa))).status).toBe(403);
    // Own person: name, role, ntfy topic.
    expect((await fetch(`${base}/api/people/ewa`, put({ id: "ewa", name: "Ewa M", role: "eng", canCreateRules: false, ntfyTopic: "ewa-t" }, ewa))).status).toBe(200);

    expect((await fetch(`${base}/api/groups/g1`, put(group, anna))).status).toBe(200);
    expect((await fetch(`${base}/api/groups/g1`, del(anna))).status).toBe(204);
    expect((await fetch(`${base}/api/rules/r1`, del(anna))).status).toBe(204);
  });
});
