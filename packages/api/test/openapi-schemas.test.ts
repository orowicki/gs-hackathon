import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import pg from "pg";
import { parse as parseYaml } from "yaml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createConfigStore, migrate, type ConfigStore } from "@alerting/config";
import type { Alert } from "@alerting/shared";
import { createServer } from "../src/server.js";
import { createPgAlertStores, createPgEventLoader } from "../src/routes/alerts/store.js";
import type { AlertsApiDeps } from "../src/routes/common.js";
import { buildOpenApi } from "../src/openapi.js";

// Loaded by path so tsc (rootDir: packages/api) does not pull scripts/ into the project.
const rendererPath = new URL("../../../scripts/docs/api-reference.ts", import.meta.url).href;
const { renderApiReference } = (await import(/* @vite-ignore */ rendererPath)) as {
  renderApiReference: (doc: Record<string, unknown>) => string;
};

type Json = Record<string, unknown>;

const fixture = (n: string): Json =>
  JSON.parse(readFileSync(new URL(`./fixtures/oas-3.1/${n}`, import.meta.url), "utf8")) as Json;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];
const DOC_ID = "https://alerting.test/openapi.json";

function newAjv(): Ajv2020 {
  return new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
}

/** Every operation as { method, path, op }. */
function operations(doc: Json): { method: string; path: string; op: Json }[] {
  const out: { method: string; path: string; op: Json }[] = [];
  const paths = isObj(doc.paths) ? doc.paths : {};
  for (const [path, item] of Object.entries(paths)) {
    if (!isObj(item)) continue;
    for (const m of METHODS) if (isObj(item[m])) out.push({ method: m, path, op: item[m] });
  }
  return out;
}

function collectRefs(node: unknown, at: string, out: { ref: string; at: string }[] = []): { ref: string; at: string }[] {
  if (Array.isArray(node)) node.forEach((v, i) => collectRefs(v, `${at}/${i}`, out));
  else if (isObj(node)) {
    for (const [k, v] of Object.entries(node)) {
      if (k === "$ref" && typeof v === "string") out.push({ ref: v, at });
      else collectRefs(v, `${at}/${k}`, out);
    }
  }
  return out;
}

function resolvePointer(doc: Json, ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;
  let cur: unknown = doc;
  for (const raw of ref.slice(2).split("/")) {
    const key = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isObj(cur) && !Array.isArray(cur)) return undefined;
    cur = (cur as Json)[key];
    if (cur === undefined) return undefined;
  }
  return cur;
}

/** Schema + examples of every requestBody media type. */
function requestBodies(doc: Json) {
  const out: { where: string; mediaType: string; pointer: string; examples: [string, unknown][] }[] = [];
  for (const { method, path, op } of operations(doc)) {
    const content = isObj(op.requestBody) && isObj(op.requestBody.content) ? op.requestBody.content : {};
    for (const [mediaType, media] of Object.entries(content)) {
      const m = isObj(media) ? media : {};
      const examples = isObj(m.examples)
        ? Object.entries(m.examples).map(([n, e]): [string, unknown] => [n, isObj(e) ? e.value : undefined])
        : [];
      const esc = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");
      out.push({
        where: `${method.toUpperCase()} ${path}`,
        mediaType,
        pointer: `#/paths/${encodeURIComponent(esc(path))}/${method}/requestBody/content/${encodeURIComponent(esc(mediaType))}/schema`,
        examples,
      });
    }
  }
  return out;
}

describe("openapi document", () => {
  const doc = buildOpenApi();

  it("is a valid OpenAPI 3.1 document (official meta-schema)", () => {
    const ajv = newAjv();
    // Ajv mis-resolves the meta-schema's `$dynamicRef: "#meta"` (it picks the wrong dynamic anchor), so
    // point it at the permissive Schema Object definition it targets by default. The Schema Objects
    // themselves are checked as JSON Schema 2020-12 when they are compiled in the example test.
    const text = JSON.stringify(fixture("schema-2022-10-07.json")).replaceAll(
      '{"$dynamicRef":"#meta"}',
      '{"$ref":"#/$defs/schema"}',
    );
    const validate = ajv.compile(JSON.parse(text) as Json);
    const ok = validate(doc);
    expect(ok, JSON.stringify(validate.errors?.slice(0, 10), null, 2)).toBe(true);
  });

  it("every $ref resolves", () => {
    const refs = collectRefs(doc, "#");
    const bad = refs.filter((r) => resolvePointer(doc, r.ref) === undefined).map((r) => `${r.at} -> ${r.ref}`);
    expect(bad).toEqual([]);
  });

  it("request body examples validate against their schema", () => {
    const ajv = newAjv();
    ajv.addSchema({ $id: DOC_ID, ...doc });
    const failures: string[] = [];
    for (const rb of requestBodies(doc)) {
      const validate = ajv.compile({ $ref: `${DOC_ID}${rb.pointer}` });
      for (const [name, value] of rb.examples) {
        if (!validate(value)) {
          failures.push(`${rb.where} ${rb.mediaType} example ${name}: ${ajv.errorsText(validate.errors)}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("every request body has at least one example", () => {
    const missing: string[] = [];
    for (const { method, path, op } of operations(doc)) {
      if (!op.requestBody) continue;
      const bodies = requestBodies(doc).filter((b) => b.where === `${method.toUpperCase()} ${path}`);
      if (!bodies.some((b) => b.examples.length > 0)) missing.push(`${method.toUpperCase()} ${path}`);
    }
    expect(missing).toEqual([]);
  });

  it("400 and 404 responses reference the Error schema", () => {
    const bad: string[] = [];
    for (const { method, path, op } of operations(doc)) {
      const responses = isObj(op.responses) ? op.responses : {};
      for (const status of ["400", "404"]) {
        if (!(status in responses)) continue;
        const content = isObj(responses[status]) && isObj(responses[status].content) ? responses[status].content : {};
        const refs = Object.values(content).map((m) => (isObj(m) && isObj(m.schema) ? m.schema.$ref : undefined));
        if (!refs.length || refs.some((r) => r !== "#/components/schemas/Error")) {
          bad.push(`${method.toUpperCase()} ${path} ${status}`);
        }
      }
    }
    expect(bad).toEqual([]);
    expect(isObj(doc.components) && isObj(doc.components.schemas) && "Error" in doc.components.schemas).toBe(true);
  });

  it("every component schema and every request/response schema compiles as JSON Schema 2020-12", () => {
    const ajv = newAjv();
    ajv.addSchema({ $id: DOC_ID, ...doc });
    const failures: string[] = [];
    const esc = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");
    const pointers: string[] = [];
    const schemas = isObj(doc.components) && isObj(doc.components.schemas) ? doc.components.schemas : {};
    for (const name of Object.keys(schemas)) pointers.push(`#/components/schemas/${encodeURIComponent(esc(name))}`);
    for (const { method, path, op } of operations(doc)) {
      const base = `#/paths/${encodeURIComponent(esc(path))}/${method}`;
      const rbc = isObj(op.requestBody) && isObj(op.requestBody.content) ? op.requestBody.content : {};
      for (const mt of Object.keys(rbc)) pointers.push(`${base}/requestBody/content/${encodeURIComponent(esc(mt))}/schema`);
      const responses = isObj(op.responses) ? op.responses : {};
      for (const [status, r] of Object.entries(responses)) {
        const content = isObj(r) && isObj(r.content) ? r.content : {};
        for (const mt of Object.keys(content)) {
          pointers.push(`${base}/responses/${status}/content/${encodeURIComponent(esc(mt))}/schema`);
        }
      }
      for (const [i, p] of (Array.isArray(op.parameters) ? op.parameters : []).entries()) {
        if (isObj(p) && isObj(p.schema)) pointers.push(`${base}/parameters/${i}/schema`);
      }
    }
    expect(pointers.length).toBeGreaterThan(Object.keys(schemas).length);
    for (const pointer of pointers) {
      try {
        ajv.compile({ $ref: `${DOC_ID}${pointer}` });
      } catch (e) {
        failures.push(`${pointer}: ${(e as Error).message}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("the operations marked x-not-implemented are exactly the four without a handler (update when #108 lands)", () => {
    const marked = operations(doc)
      .filter(({ op }) => op["x-not-implemented"] === true)
      .map(({ method, path, op }) => {
        expect(String(op.description).startsWith("Not implemented yet (issue #108)"), `${method} ${path}`).toBe(true);
        return `${method.toUpperCase()} ${path}`;
      })
      .sort();
    expect(marked).toEqual(
      ["GET /api/events", "GET /api/sources/{id}/preview", "POST /api/schemas/test", "POST /api/sources/test"].sort(),
    );
  });

  it("docs/api.md is up to date", () => {
    const current = readFileSync(new URL("../../../docs/api.md", import.meta.url), "utf8");
    expect(current === renderApiReference(doc), "docs/api.md is out of date: run `just docs-api`").toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Handler conformance: send the documented request examples to the real in-process server (real Postgres
// and Redis) and validate status, headers and body against the documented response.
// ---------------------------------------------------------------------------------------------------------

const hasInfra = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);

describe("handler conformance prerequisites", () => {
  // The CI workflow provides Postgres and Redis; never let the conformance suite skip silently there.
  it.runIf(Boolean(process.env.CI))("DATABASE_URL and REDIS_URL are set in CI", () => {
    expect(hasInfra, "CI must provide DATABASE_URL and REDIS_URL so the handler conformance tests run").toBe(true);
  });
});

const rootUrl = new URL("../../../", import.meta.url);

describe.skipIf(!hasInfra)("handler conformance", () => {
  const doc = buildOpenApi();
  const ajv = newAjv();
  ajv.addSchema({ $id: DOC_ID, ...doc });
  const esc = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");
  const ops = new Map(operations(doc).map((o) => [`${o.method.toUpperCase()} ${o.path}`, o]));
  const compiled = new Map<string, ReturnType<Ajv2020["compile"]>>();

  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const alertPrefix = `oas-${suffix}-`;
  const ran: string[] = [];
  let pool: pg.Pool;
  let store: ConfigStore;
  let server: Server;
  let url: string;

  /** Every id used by a POST create example (plus the owners of the preference examples) gets the run suffix. */
  const knownIds = new Set<string>(["anna", "rates-desk"]);
  for (const key of ops.keys()) {
    if (!key.startsWith("POST /api/") || key.includes("{")) continue;
    for (const rb of requestBodies(doc).filter((b) => b.where === key && b.mediaType === "application/json")) {
      for (const [, v] of rb.examples) if (isObj(v) && typeof v.id === "string") knownIds.add(v.id);
    }
  }
  function uniq(value: unknown): unknown {
    if (typeof value === "string") {
      if (knownIds.has(value)) return `${value}-${suffix}`;
      // YAML text (import examples): the entity id is its first-level `id:` line.
      return value.replace(/^id: (.+)$/m, (_m, id: string) => `id: ${id}-${suffix}`);
    }
    if (Array.isArray(value)) return value.map(uniq);
    if (isObj(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, uniq(v)]));
    return value;
  }

  function example(key: string, name?: string, mediaType = "application/json"): unknown {
    const rb = requestBodies(doc).find((b) => b.where === key && b.mediaType === mediaType);
    const found = name ? rb?.examples.find(([n]) => n === name) : rb?.examples[0];
    if (!found) throw new Error(`no example ${name ?? "(first)"} for ${key} (${mediaType})`);
    return uniq(found[1]);
  }
  const exampleNames = (key: string, mediaType = "application/json") =>
    requestBodies(doc)
      .find((b) => b.where === key && b.mediaType === mediaType)
      ?.examples.map(([n]) => n) ?? [];

  function responseValidator(key: string, status: number, mediaType: string) {
    const id = `${key}|${status}|${mediaType}`;
    let v = compiled.get(id);
    if (!v) {
      const [method, path] = key.split(" ") as [string, string];
      const pointer = `#/paths/${encodeURIComponent(esc(path!))}/${method.toLowerCase()}/responses/${status}/content/${encodeURIComponent(esc(mediaType))}/schema`;
      v = ajv.compile({ $ref: `${DOC_ID}${pointer}` });
      compiled.set(id, v);
    }
    return v;
  }

  interface Call {
    path?: Record<string, string | number>;
    query?: Record<string, string>;
    body?: unknown;
    /** Media type of `body` (default application/json). */
    bodyType?: string;
    /** Expected status (default: the documented success status). */
    status?: number;
  }

  /** Send one request for the operation, then check status, headers and body against the document. */
  async function call(key: string, c: Call = {}): Promise<{ status: number; body: unknown; headers: Headers }> {
    const entry = ops.get(key);
    if (!entry) throw new Error(`operation not documented: ${key}`);
    const { op } = entry;
    const [method, tpl] = key.split(" ") as [string, string];
    const target = tpl.replace(/\{(\w+)\}/g, (_, n: string) => encodeURIComponent(String(c.path?.[n])));
    const params = (isObj(op) && Array.isArray(op.parameters) ? op.parameters : []) as Json[];
    for (const name of Object.keys(c.query ?? {})) {
      expect(params.some((p) => p.in === "query" && p.name === name), `${key}: query parameter ${name} is not documented`).toBe(true);
    }
    const qs = c.query ? `?${new URLSearchParams(c.query).toString()}` : "";
    const init: RequestInit = { method };
    if (c.body !== undefined) {
      const mt = c.bodyType ?? "application/json";
      const rbContent = isObj(op.requestBody) && isObj(op.requestBody.content) ? op.requestBody.content : {};
      expect(mt in rbContent, `${key}: request media type ${mt} is not documented`).toBe(true);
      init.headers = { "content-type": mt };
      init.body = typeof c.body === "string" ? c.body : JSON.stringify(c.body);
    }
    const res = await fetch(`${url}${target}${qs}`, init);
    ran.push(key);

    const responses = isObj(op.responses) ? op.responses : {};
    const documented = Object.keys(responses).filter((s) => s.startsWith("2")).sort();
    const want = c.status ?? Number(documented[0]);
    const text = await res.text();
    expect(res.status, `${key} -> ${res.status} ${text.slice(0, 300)}`).toBe(want);
    const spec = responses[String(want)];
    expect(isObj(spec), `${key}: status ${want} is not documented`).toBe(true);
    const content = isObj(spec) && isObj(spec.content) ? spec.content : {};
    const mediaTypes = Object.keys(content);
    const got = (res.headers.get("content-type") ?? "").split(";")[0]!.trim();
    let body: unknown = text;
    if (mediaTypes.length === 0) {
      expect(text, `${key}: documented as bodiless`).toBe("");
    } else {
      expect(mediaTypes, `${key}: content-type ${got} is not documented`).toContain(got);
      if (got === "application/json") body = JSON.parse(text);
      const validate = responseValidator(key, want, got);
      // A YAML response is documented as a string: validate the text, and separately require that it parses.
      expect(validate(body), `${key} ${want} body does not match its schema: ${JSON.stringify(validate.errors?.slice(0, 5))}\n${text.slice(0, 400)}`).toBe(true);
    }
    if (got === "application/yaml") body = parseYaml(text);
    const documentedHeaders = isObj(spec) && isObj(spec.headers) ? Object.keys(spec.headers) : [];
    for (const h of ["x-next-before"]) {
      if (res.headers.has(h)) expect(documentedHeaders, `${key}: header ${h} is sent but not documented`).toContain(h);
    }
    return { status: res.status, body: body, headers: res.headers };
  }

  const cleanup = async (): Promise<void> => {
    if (!pool) return;
    const like = `%${suffix}%`;
    for (const t of ["sources", "schemas", "rules", "people", "groups", "preferences", "runbooks"]) {
      await pool.query(`DELETE FROM ${t} WHERE id LIKE $1`, [like]);
    }
    await pool.query("DELETE FROM alert_audit WHERE alert_id LIKE $1", [`${alertPrefix}%`]);
    await pool.query("DELETE FROM alerts WHERE id LIKE $1", [`${alertPrefix}%`]);
  };

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    await migrate(pool);
    store = createConfigStore({ pool, redisUrl: process.env.REDIS_URL });
    const stores = createPgAlertStores(pool);
    const alerts: AlertsApiDeps = { ...stores, events: createPgEventLoader(pool) };
    server = createServer({ checkPostgres: async () => true, checkRedis: async () => true, config: store, alerts });
    await new Promise<void>((r) => server.listen(0, r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server?.closeAllConnections();
    await new Promise((r) => server?.close(r));
    try {
      await cleanup();
    } finally {
      await store?.close();
      await pool?.end();
    }
  });

  const crud: { name: string; base: string }[] = [
    { name: "sources", base: "/api/sources" },
    { name: "schemas", base: "/api/schemas" },
    { name: "rules", base: "/api/rules" },
    { name: "people", base: "/api/people" },
    { name: "groups", base: "/api/groups" },
    { name: "runbooks", base: "/api/runbooks" },
  ];

  describe.each(crud)("config CRUD: $name", ({ base }) => {
    it("create (every example), list, get, replace, delete", async () => {
      const created: string[] = [];
      for (const name of exampleNames(`POST ${base}`)) {
        const body = example(`POST ${base}`, name) as { id: string };
        const r = await call(`POST ${base}`, { body });
        expect(r.body).toEqual(body);
        created.push(body.id);
      }
      const list = (await call(`GET ${base}`)).body as { id: string }[];
      for (const id of created) expect(list.map((x) => x.id)).toContain(id);
      for (const id of created) await call(`GET ${base}/{id}`, { path: { id } });
      const put = example(`PUT ${base}/{id}`) as { id: string };
      expect(created).toContain(put.id);
      await call(`PUT ${base}/{id}`, { path: { id: put.id }, body: put });
      for (const id of created) await call(`DELETE ${base}/{id}`, { path: { id } });
    });
  });

  it("preferences and starred filters", async () => {
    const person = example("POST /api/people", "anna") as { id: string };
    const group = example("POST /api/groups", "ratesDesk") as { id: string };
    await call("POST /api/people", { body: person });
    await call("POST /api/groups", { body: group });
    try {
      for (const [base, id] of [
        ["/api/people", person.id],
        ["/api/groups", group.id],
      ] as const) {
        // Before anything is stored the documented "empty preference" is returned.
        await call(`GET ${base}/{id}/preferences`, { path: { id } });
        const pref = example(`PUT ${base}/{id}/preferences`);
        await call(`PUT ${base}/{id}/preferences`, { path: { id }, body: pref });
        const back = await call(`GET ${base}/{id}/preferences`, { path: { id } });
        expect(back.body).toEqual(pref);
      }
      const key = "GET /api/people/{id}/starred-filters";
      await call(key, { path: { id: person.id } });
      const filters = example("PUT /api/people/{id}/starred-filters");
      const put = await call("PUT /api/people/{id}/starred-filters", { path: { id: person.id }, body: filters });
      expect((put.body as unknown[]).length).toBe((filters as unknown[]).length);
      expect((await call(key, { path: { id: person.id } })).body).toEqual(put.body);
    } finally {
      await call("DELETE /api/groups/{id}", { path: { id: group.id } });
      await call("DELETE /api/people/{id}", { path: { id: person.id } });
    }
  });

  it.each([
    ["schemas", "/api/schemas"],
    ["sources", "/api/sources"],
    ["rules", "/api/rules"],
  ])("yaml export and import: %s", async (_n, base) => {
    const item = example(`POST ${base}`) as { id: string };
    await call(`POST ${base}`, { body: item });
    const ids = [item.id];
    try {
      const out = await call(`GET ${base}/{id}/export`, { path: { id: item.id } });
      expect(out.headers.get("content-type")).toContain("application/yaml");
      expect(isObj(out.body) && out.body.id).toBe(item.id);
      for (const name of exampleNames(`POST ${base}/import`, "application/yaml")) {
        const text = example(`POST ${base}/import`, name, "application/yaml") as string;
        const imported = await call(`POST ${base}/import`, { body: text, bodyType: "application/yaml" });
        ids.push((imported.body as { id: string }).id);
        expect((imported.body as { id: string }).id).toContain(suffix);
      }
    } finally {
      for (const id of ids) await call(`DELETE ${base}/{id}`, { path: { id } });
    }
  });

  it("filters parse and format", async () => {
    const parsed = await call("POST /api/filters/parse", { body: example("POST /api/filters/parse") });
    const tree = (parsed.body as { tree: unknown }).tree;
    const formatted = await call("POST /api/filters/format", { body: example("POST /api/filters/format") });
    expect(typeof (formatted.body as { text: string }).text).toBe("string");
    await call("POST /api/filters/format", { body: { tree } });
  });

  it("alerts: list, get, ack, resolve, audit", async () => {
    const stores = createPgAlertStores(pool);
    const mk = (i: number): Alert => {
      const a = JSON.parse(readFileSync(new URL("fixtures/alerts/metric-breach.json", rootUrl), "utf8")) as Alert;
      delete a.acknowledgedBy;
      delete a.acknowledgedAt;
      delete a.resolvedAt;
      return { ...a, id: `${alertPrefix}${i}`, state: "open", lastSeen: `2026-10-23T09:1${i}:00.000Z` };
    };
    const [a0, a1] = [mk(0), mk(1)] as [Alert, Alert];
    await stores.alerts.upsert(a0);
    await stores.alerts.upsert(a1);

    const q = { limit: "200", state: "open" };
    const list = await call("GET /api/alerts", { query: q });
    expect((list.body as Alert[]).map((a) => a.id)).toEqual(expect.arrayContaining([a0.id, a1.id]));
    await call("GET /api/alerts", { query: { filter: "alert.severity >= error", limit: "5" } });
    await call("GET /api/alerts", {
      query: { tree: JSON.stringify({ type: "cmp", field: "alert.severity", op: "=", value: "critical" }), limit: "5" },
    });
    const page = await call("GET /api/alerts", { query: { limit: "1", state: "open" } });
    const next = page.headers.get("x-next-before");
    expect(next).toBeTruthy();
    await call("GET /api/alerts", { query: { limit: "1", before: next!, state: "open" } });

    await call("GET /api/alerts/{id}", { path: { id: a0.id } });
    await call("POST /api/alerts/{id}/ack", { path: { id: a0.id }, body: example("POST /api/alerts/{id}/ack") });
    await call("GET /api/alerts/{id}", { path: { id: a0.id } });
    await call("POST /api/alerts/{id}/resolve", { path: { id: a1.id }, body: example("POST /api/alerts/{id}/resolve") });
    await call("POST /api/alerts/{id}/resolve", { path: { id: a0.id }, body: example("POST /api/alerts/{id}/resolve") });

    const audit = await call("GET /api/alerts/{id}/audit", { path: { id: a0.id } });
    expect((audit.body as unknown[]).length).toBe(2);
    const all = await call("GET /api/audit", { query: { alertId: a0.id, limit: "10" } });
    expect((all.body as unknown[]).length).toBe(2);
    await call("GET /api/audit", { query: { alertId: a1.id, actor: "marek", action: "resolved", before: "2099-01-01T00:00:00.000Z" } });
  });

  it("exercised the documented operations", () => {
    const expected = [
      ...crud.flatMap(({ base }) => [`POST ${base}`, `GET ${base}`, `GET ${base}/{id}`, `PUT ${base}/{id}`, `DELETE ${base}/{id}`]),
      "GET /api/people/{id}/preferences",
      "PUT /api/groups/{id}/preferences",
      "PUT /api/people/{id}/starred-filters",
      "POST /api/schemas/import",
      "GET /api/rules/{id}/export",
      "POST /api/filters/parse",
      "POST /api/filters/format",
      "GET /api/alerts",
      "GET /api/alerts/{id}",
      "POST /api/alerts/{id}/ack",
      "POST /api/alerts/{id}/resolve",
      "GET /api/alerts/{id}/audit",
      "GET /api/audit",
    ];
    // Only meaningful when the whole file ran (not with -t); then every one of these must have been sent.
    if (ran.length > 0) for (const k of expected) expect(ran, k).toContain(k);
  });
});
