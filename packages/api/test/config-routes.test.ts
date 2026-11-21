import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import pg from "pg";
import { createConfigStore, migrate, entityId, type ChangeHandler, type ConfigStore, type Kind } from "@alerting/config";
import { createServer } from "../src/server.js";

function memoryStore(): ConfigStore {
  const data = new Map<Kind, Map<string, unknown>>();
  const handlers = new Set<{ kind: Kind | "*"; fn: ChangeHandler }>();
  const table = (k: Kind) => data.get(k) ?? data.set(k, new Map()).get(k)!;
  const fire = (kind: Kind, id: string, op: "upsert" | "delete") => {
    for (const h of handlers) if (h.kind === "*" || h.kind === kind) void h.fn({ kind, id, op });
  };
  return {
    async list(kind) {
      return [...table(kind).values()] as never;
    },
    async get(kind, id) {
      return table(kind).get(id) as never;
    },
    async upsert(kind, entity) {
      const id = entityId(kind, entity);
      table(kind).set(id, structuredClone(entity));
      fire(kind, id, "upsert");
    },
    async delete(kind, id) {
      const had = table(kind).delete(id);
      if (had) fire(kind, id, "delete");
      return had;
    },
    async onChange(kind, fn) {
      const h = { kind, fn };
      handlers.add(h);
      return () => void handlers.delete(h);
    },
    async close() {},
  };
}

let server: Server | undefined;
async function start(config?: ConfigStore): Promise<string> {
  server = createServer({ checkPostgres: async () => true, checkRedis: async () => true, config });
  await new Promise<void>((r) => server!.listen(0, r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise((r) => server?.close(r));
  server = undefined;
});

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

const samples: Record<string, Record<string, unknown>> = {
  sources: { id: "s1", name: "S", type: "http" },
  schemas: { id: "sc1", name: "Sch" },
  rules: { id: "r1", name: "R" },
  people: { id: "p1", name: "P", role: "dev", canCreateRules: true },
  groups: { id: "g1", name: "G", memberIds: ["p1"] },
  runbooks: { id: "rb1", name: "RB", steps: [] },
};

describe("config CRUD", () => {
  it.each(Object.keys(samples))("round trip for %s", async (coll) => {
    const url = await start(memoryStore());
    const item = samples[coll]!;
    expect(await (await fetch(`${url}/api/${coll}`)).json()).toEqual([]);
    const created = await fetch(`${url}/api/${coll}`, json("POST", item));
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual(item);
    expect((await fetch(`${url}/api/${coll}`, json("POST", item))).status).toBe(409);
    expect(await (await fetch(`${url}/api/${coll}`)).json()).toEqual([item]);
    expect(await (await fetch(`${url}/api/${coll}/${item.id}`)).json()).toEqual(item);
    const updated = { ...item, name: "changed" };
    const put = await fetch(`${url}/api/${coll}/${item.id}`, json("PUT", updated));
    expect(put.status).toBe(200);
    expect(await (await fetch(`${url}/api/${coll}/${item.id}`)).json()).toEqual(updated);
    expect((await fetch(`${url}/api/${coll}/${item.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await fetch(`${url}/api/${coll}/${item.id}`)).status).toBe(404);
    expect((await fetch(`${url}/api/${coll}/${item.id}`, { method: "DELETE" })).status).toBe(404);
  });

  it("returns 400 with a plain message for invalid bodies", async () => {
    const url = await start(memoryStore());
    const cases: [string, string, unknown][] = [
      ["POST", "/api/rules", "{not json"],
      ["POST", "/api/rules", [1]],
      ["POST", "/api/rules", { name: "no id" }],
      ["PUT", "/api/rules/a", { id: "b" }],
      ["PUT", "/api/rules/a", "nope"],
    ];
    for (const [m, p, b] of cases) {
      const r = await fetch(url + p, json(m, b));
      expect(r.status, `${m} ${p}`).toBe(400);
      expect(typeof ((await r.json()) as { error: string }).error).toBe("string");
    }
  });

  it("404 on PUT of a missing entity and 503 without a store", async () => {
    const url = await start(memoryStore());
    expect((await fetch(`${url}/api/rules/zz`, json("PUT", { id: "zz" }))).status).toBe(404);
    await new Promise((r) => server!.close(r));
    const url2 = await start();
    expect((await fetch(`${url2}/api/rules`)).status).toBe(503);
  });

  it("leaves other routes alone", async () => {
    const url = await start(memoryStore());
    expect((await fetch(`${url}/api/unknown`)).status).toBe(404);
    expect((await fetch(`${url}/api/rules/a/suggestions`)).status).toBe(404);
    expect((await fetch(`${url}/health`)).status).toBe(200);
  });

  it("notifies store subscribers of new rules and schemas within 2 s", async () => {
    const store = memoryStore();
    const seen: string[] = [];
    await store.onChange("*", (c) => void seen.push(`${c.kind}:${c.id}`));
    const url = await start(store);
    const waitFor = async (event: string) => {
      const deadline = Date.now() + 2000;
      while (!seen.includes(event) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      expect(seen, `no ${event} within 2000 ms`).toContain(event);
    };
    await fetch(`${url}/api/rules`, json("POST", samples.rules));
    await waitFor("rule:r1");
    await fetch(`${url}/api/schemas`, json("POST", samples.schemas));
    await waitFor("schema:sc1");
  });

  it("does not resolve inherited object properties as collections", async () => {
    const url = await start(memoryStore());
    for (const p of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      for (const sub of ["", "/x", "/x/export"]) {
        const r = await fetch(`${url}/api/${p}${sub}`);
        expect(r.status, p + sub).toBe(404);
      }
    }
  });

  it("answers /test routes from the try routes, not as config ids (with or without a store)", async () => {
    for (const store of [undefined, memoryStore()]) {
      const url = await start(store);
      for (const p of ["/api/schemas/test", "/api/sources/test"]) {
        const r = await fetch(url + p, json("POST", {}));
        expect(r.status, p).toBe(400);
        expect(typeof ((await r.json()) as { error: string }).error).toBe("string");
      }
      expect((await fetch(`${url}/api/sources/s1/preview`)).status).toBe(503);
      await new Promise((r) => server!.close(r));
    }
  });

  it("rejects reserved ids and control characters in ids", async () => {
    const url = await start(memoryStore());
    for (const id of ["import", "export", "test", "bad\u0000id", "tab\tid"]) {
      const r = await fetch(`${url}/api/rules`, json("POST", { id, name: "x" }));
      expect(r.status, id).toBe(400);
      expect(typeof ((await r.json()) as { error: string }).error).toBe("string");
      if (id !== "import") {
        // PUT /api/rules/import is not a route (import is POST only).
        expect((await fetch(`${url}/api/rules/${encodeURIComponent(id)}`, json("PUT", { id, name: "x" }))).status, id).toBe(400);
      }
    }
    const imp = await fetch(`${url}/api/rules/import`, { method: "POST", body: "id: import\nname: x\n" });
    expect(imp.status).toBe(400);
    expect((await fetch(`${url}/api/rules/a%00b`)).status).toBe(400);
    expect((await fetch(`${url}/api/people/a%00b/preferences`)).status).toBe(400);
  });
});

describe("preferences and starred filters", () => {
  it("gets, sets and validates preferences", async () => {
    const store = memoryStore();
    const url = await start(store);
    expect((await fetch(`${url}/api/people/p1/preferences`)).status).toBe(404);
    await fetch(`${url}/api/people`, json("POST", samples.people));
    await fetch(`${url}/api/groups`, json("POST", samples.groups));
    expect(await (await fetch(`${url}/api/people/p1/preferences`)).json()).toEqual({
      ownerType: "person",
      ownerId: "p1",
      rules: [],
    });
    const pref = { rules: [{ when: { type: "cmp", field: "alert.severity", op: "=", value: "critical" }, channels: ["ntfy"] }] };
    const put = await fetch(`${url}/api/people/p1/preferences`, json("PUT", pref));
    expect(put.status).toBe(200);
    expect(await store.get("preference", "person:p1")).toMatchObject({ ownerType: "person", ownerId: "p1", ...pref });
    expect(await (await fetch(`${url}/api/people/p1/preferences`)).json()).toMatchObject(pref);
    expect((await fetch(`${url}/api/groups/g1/preferences`, json("PUT", pref))).status).toBe(200);
    expect(await store.get("preference", "group:g1")).toBeDefined();
    expect((await fetch(`${url}/api/people/p1/preferences`, json("PUT", { rules: "x" }))).status).toBe(400);
    expect((await fetch(`${url}/api/people/p1/preferences`, json("PUT", { ownerId: "p2", rules: [] }))).status).toBe(400);
  });

  it("stores starred filters on the person and keeps them across PUT", async () => {
    const url = await start(memoryStore());
    expect((await fetch(`${url}/api/people/p1/starred-filters`)).status).toBe(404);
    await fetch(`${url}/api/people`, json("POST", samples.people));
    expect(await (await fetch(`${url}/api/people/p1/starred-filters`)).json()).toEqual([]);
    const f = { id: "f1", name: "Crit", filter: { type: "cmp", field: "alert.severity", op: "=", value: "critical" } };
    const put = await fetch(`${url}/api/people/p1/starred-filters`, json("PUT", [f]));
    expect(put.status).toBe(200);
    const expected = [{ ...f, personId: "p1" }];
    expect(await put.json()).toEqual(expected);
    expect(await (await fetch(`${url}/api/people/p1/starred-filters`)).json()).toEqual(expected);
    await fetch(`${url}/api/people/p1`, json("PUT", { ...samples.people, name: "New" }));
    expect(await (await fetch(`${url}/api/people/p1/starred-filters`)).json()).toEqual(expected);
    expect((await fetch(`${url}/api/people/p1/starred-filters`, json("PUT", { a: 1 }))).status).toBe(400);
    expect((await fetch(`${url}/api/people/p1/starred-filters`, json("PUT", [{ id: "x" }]))).status).toBe(400);
  });
});

describe("yaml export/import", () => {
  it.each(["sources", "schemas", "rules"])("round trips %s", async (coll) => {
    const store = memoryStore();
    const url = await start(store);
    const item = samples[coll]!;
    expect((await fetch(`${url}/api/${coll}/${item.id}/export`)).status).toBe(404);
    await fetch(`${url}/api/${coll}`, json("POST", item));
    const ex = await fetch(`${url}/api/${coll}/${item.id}/export`);
    expect(ex.headers.get("content-type")).toContain("application/yaml");
    const text = await ex.text();
    await fetch(`${url}/api/${coll}/${item.id}`, { method: "DELETE" });
    const imp = await fetch(`${url}/api/${coll}/import`, { method: "POST", body: text, headers: { "content-type": "application/yaml" } });
    expect(imp.status).toBe(200);
    expect(await imp.json()).toEqual(item);
    expect(await (await fetch(`${url}/api/${coll}/${item.id}`)).json()).toEqual(item);
  });

  it("rejects bad YAML and entities without id", async () => {
    const url = await start(memoryStore());
    for (const body of ["a: [unclosed", "name: x\n", "- 1\n"]) {
      const r = await fetch(`${url}/api/rules/import`, { method: "POST", body });
      expect(r.status).toBe(400);
      expect(typeof ((await r.json()) as { error: string }).error).toBe("string");
    }
  });
});

describe("filter routes", () => {
  it("parses, reports errors with position, and formats", async () => {
    const url = await start();
    const ok = await fetch(`${url}/api/filters/parse`, json("POST", { text: "alert.severity = critical" }));
    expect(ok.status).toBe(200);
    const { tree } = (await ok.json()) as { tree: unknown };
    expect(tree).toMatchObject({ type: "cmp", field: "alert.severity" });
    const bad = await fetch(`${url}/api/filters/parse`, json("POST", { text: "alert.severity =" }));
    expect(bad.status).toBe(400);
    const err = (await bad.json()) as { error: string; position: number };
    expect(typeof err.error).toBe("string");
    expect(typeof err.position).toBe("number");
    expect((await fetch(`${url}/api/filters/parse`, json("POST", { nope: 1 }))).status).toBe(400);

    const fmt = await fetch(`${url}/api/filters/format`, json("POST", { tree }));
    expect(fmt.status).toBe(200);
    const { text } = (await fmt.json()) as { text: string };
    const back = await fetch(`${url}/api/filters/parse`, json("POST", { text }));
    expect(((await back.json()) as { tree: unknown }).tree).toEqual(tree);
    expect((await fetch(`${url}/api/filters/format`, json("POST", { tree: { type: "zzz" } }))).status).toBe(400);
  });

  it("suggests fields, operators and values", async () => {
    const url = await start();
    const get = async (q: string) => (await (await fetch(`${url}/api/filters/suggest?${q}`)).json()) as string[];
    expect(await get("text=alert.sev")).toEqual(["alert.severity"]);
    expect(await get("text=" + encodeURIComponent("alert.severity "))).toContain("=");
    expect(await get("text=" + encodeURIComponent("alert.severity = c"))).toEqual(["critical"]);
    expect(await get("text=" + encodeURIComponent("alert.severity = info "))).toEqual(["AND", "OR"]);
    expect((await get("")).length).toBeGreaterThan(3);
  });
});

describe.skipIf(!process.env.DATABASE_URL || !process.env.REDIS_URL)("with the real config store", () => {
  it("rule and schema created via the API reach a subscriber within 2 s", async () => {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    await migrate(pool);
    const store = createConfigStore({ pool, redisUrl: process.env.REDIS_URL });
    try {
      const got: string[] = [];
      const unsub = await store.onChange("*", (c) => void got.push(`${c.kind}:${c.id}`));
      const url = await start(store);
      const suffix = Date.now();
      await fetch(`${url}/api/rules`, json("POST", { id: `api-r-${suffix}`, name: "R" }));
      await fetch(`${url}/api/schemas`, json("POST", { id: `api-s-${suffix}`, name: "S" }));
      const deadline = Date.now() + 2000;
      while (got.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
      unsub();
      expect(got).toEqual(expect.arrayContaining([`rule:api-r-${suffix}`, `schema:api-s-${suffix}`]));
      await fetch(`${url}/api/rules/api-r-${suffix}`, { method: "DELETE" });
      await fetch(`${url}/api/schemas/api-s-${suffix}`, { method: "DELETE" });
    } finally {
      await store.close();
      await pool.end();
    }
  });
});

describe("rule runbook (YAML, one per rule)", () => {
  it("creates, replaces, reads and deletes the rule's own runbook", async () => {
    const store = memoryStore();
    await store.upsert("rule", samples.rules as never);
    const url = await start(store);
    const ruleId = String(samples.rules!.id);
    const put = (body: string) => fetch(`${url}/api/rules/${ruleId}/runbook`, { method: "PUT", body, headers: { "content-type": "application/yaml" } });

    expect((await fetch(`${url}/api/rules/${ruleId}/runbook`)).status).toBe(404);
    expect((await fetch(`${url}/api/rules/nope/runbook`)).status).toBe(404);
    expect((await put("name: [unclosed")).status).toBe(400);
    expect((await put("type: automation\nname: X\nsteps:\n  - action: launch-rockets\n")).status).toBe(400);

    const r1 = await put("name: First\ncontent: Restart it.\n");
    expect(r1.status).toBe(200);
    const b1 = (await r1.json()) as { runbook: Record<string, unknown>; yaml: string };
    expect(b1.runbook).toMatchObject({ id: `rule-${ruleId}`, type: "text", matches: `alert.ruleId = "${ruleId}"`, content: "Restart it." });
    expect(b1.yaml).not.toContain("matches");

    // A second PUT overwrites; a smuggled id/matches is ignored.
    const r2 = await put(`id: other\nmatches: "true"\nname: Second\ntype: automation\nsteps:\n  - action: wait\n    duration: 1s\n`);
    expect(r2.status).toBe(200);
    const all = (await (await fetch(`${url}/api/runbooks`)).json()) as { id: string; name: string; matches: string }[];
    expect(all.map((r) => [r.id, r.name, r.matches])).toEqual([[`rule-${ruleId}`, "Second", `alert.ruleId = "${ruleId}"`]]);

    expect((await fetch(`${url}/api/rules/${ruleId}/runbook`, { method: "DELETE" })).status).toBe(204);
    expect((await fetch(`${url}/api/rules/${ruleId}/runbook`)).status).toBe(404);
  });
});
