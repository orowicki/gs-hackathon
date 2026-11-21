// Seeds demo data through the HTTP API. Idempotent: only creates what is missing.
// Run: node --experimental-strip-types scripts/seed/seed.ts   (env: API_URL)
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { basename, extname, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

export type SeedKind = "person" | "group" | "preference" | "schema" | "source" | "rule" | "runbook";
export type Entity = Record<string, unknown>;

/** Minimal client: `get` returns undefined when the entity does not exist. */
export interface SeedClient {
  get(kind: SeedKind, id: string): Promise<Entity | undefined>;
  put(kind: SeedKind, id: string, entity: Entity): Promise<void>;
}

export type SeedData = Record<SeedKind, { id: string; entity: Entity }[]>;
export interface SeedResult {
  created: number;
  kept: number;
  createdIds: string[];
}

/** Creation order matters: preferences need their person to exist. */
export const KIND_ORDER: SeedKind[] = ["person", "group", "preference", "schema", "source", "rule", "runbook"];

const CONFIG_DIRS: Partial<Record<SeedKind, string>> = {
  person: "people",
  group: "groups",
  schema: "schemas",
  rule: "rules",
  runbook: "runbooks",
};

export const DEMO_SOURCES: Entity[] = [
  { id: "demo-http", name: "Demo (HTTP)", enabled: true, parser: { type: "json" }, type: "http", config: {} },
  {
    id: "demo-logs",
    name: "Demo (log files)",
    enabled: true,
    parser: { type: "json" },
    type: "file_tail",
    config: { path: "/tmp/demo-logs/*.log" },
  },
  {
    id: "demo-stream",
    name: "Demo (Redis stream)",
    enabled: true,
    parser: { type: "json" },
    type: "redis_stream",
    config: { stream: "demo:events", consumerGroup: "alerting" },
  },
];

/** Anna: critical alerts also to ntfy; quiet hours 20:00-08:00 leave only the UI. */
export const ANNA_PREFERENCE: Entity = {
  ownerType: "person",
  ownerId: "anna",
  rules: [
    {
      when: { type: "cmp", field: "alert.severity", op: "=", value: "critical" },
      channels: ["ui", "ntfy"],
    },
  ],
  quietHours: { from: "20:00", to: "08:00", timezone: "Europe/Warsaw", allowChannels: ["ui"] },
};

export function loadConfigDir(dir: string): SeedData {
  const data = Object.fromEntries(KIND_ORDER.map((k) => [k, []])) as unknown as SeedData;
  for (const [kind, sub] of Object.entries(CONFIG_DIRS) as [SeedKind, string][]) {
    const d = join(dir, sub);
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d).sort()) {
      if (![".yaml", ".yml"].includes(extname(f))) continue;
      const value = parse(readFileSync(join(d, f), "utf8")) as Entity | null;
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${join(d, f)}: expected a YAML mapping`);
      }
      const id = typeof value.id === "string" ? value.id : basename(f, extname(f));
      data[kind].push({ id, entity: { ...value, id } });
    }
  }
  data.source = DEMO_SOURCES.map((e) => ({ id: e.id as string, entity: e }));
  data.preference = [{ id: "person:anna", entity: ANNA_PREFERENCE }];
  return data;
}

export async function seed(client: SeedClient, data: SeedData): Promise<SeedResult> {
  const res: SeedResult = { created: 0, kept: 0, createdIds: [] };
  for (const kind of KIND_ORDER) {
    for (const { id, entity } of data[kind]) {
      if ((await client.get(kind, id)) !== undefined) {
        res.kept++;
        continue;
      }
      await client.put(kind, id, entity);
      res.created++;
      res.createdIds.push(`${kind}/${id}`);
    }
  }
  return res;
}

const PATHS: Record<Exclude<SeedKind, "preference">, string> = {
  person: "people",
  group: "groups",
  schema: "schemas",
  source: "sources",
  rule: "rules",
  runbook: "runbooks",
};

export function httpClient(baseUrl: string): SeedClient {
  const base = baseUrl.replace(/\/$/, "");
  async function call(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(base + path, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  }
  async function fail(what: string, r: Response): Promise<never> {
    throw new Error(`${what} failed: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
  }
  return {
    async get(kind, id) {
      if (kind === "preference") {
        const [owner, ownerId] = id.split(":") as [string, string];
        const r = await call("GET", `/api/${owner === "group" ? "groups" : "people"}/${encodeURIComponent(ownerId)}/preferences`);
        if (!r.ok) return fail(`GET preference ${id}`, r);
        const p = (await r.json()) as Entity;
        // The API answers with an empty preference when none is stored.
        return Array.isArray(p.rules) && p.rules.length === 0 && p.quietHours === undefined ? undefined : p;
      }
      const r = await call("GET", `/api/${PATHS[kind]}/${encodeURIComponent(id)}`);
      if (r.status === 404) return undefined;
      if (!r.ok) return fail(`GET ${kind} ${id}`, r);
      return (await r.json()) as Entity;
    },
    async put(kind, id, entity) {
      if (kind === "preference") {
        const [owner, ownerId] = id.split(":") as [string, string];
        const r = await call("PUT", `/api/${owner === "group" ? "groups" : "people"}/${encodeURIComponent(ownerId)}/preferences`, entity);
        if (!r.ok) await fail(`PUT preference ${id}`, r);
        return;
      }
      const r = await call("POST", `/api/${PATHS[kind]}`, entity);
      // 409 = created by someone else in the meantime: fine, never overwrite.
      if (!r.ok && r.status !== 409) await fail(`POST ${kind} ${id}`, r);
    },
  };
}

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function main(): Promise<void> {
  const apiUrl = process.env.API_URL ?? "http://localhost:3000";
  const data = loadConfigDir(join(REPO_ROOT, "config"));
  const r = await seed(httpClient(apiUrl), data);
  console.log(`seed: created ${r.created}, kept ${r.kept} (${apiUrl})`);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(`seed failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
