import type http from "node:http";
import {
  exportYaml,
  fromYaml,
  importYaml,
  toYaml,
  entityId,
  type ConfigStore,
  type Kind,
} from "@alerting/config";
import {
  COMMON_FIELDS,
  KEYWORDS,
  OPERATORS,
  SEVERITY_ORDER,
  FilterSyntaxError,
  parse,
  print,
  suggestContext,
  validateTree,
} from "@alerting/filter";
import { validateRunbook } from "@alerting/runbooks";
import type { Preference, Runbook, StarredFilter } from "@alerting/shared";
import { send } from "../../http.js";

export interface ConfigDeps {
  config?: ConfigStore;
}

export const MAX_CONFIG_BYTES = 1024 * 1024;

/** URL collection name -> store kind. */
const COLLECTIONS = new Map<string, Kind>(Object.entries({
  sources: "source",
  schemas: "schema",
  rules: "rule",
  people: "person",
  groups: "group",
  runbooks: "runbook",
} as Record<string, Kind>));

/** Ids that would collide with sub-paths of the routes. */
const RESERVED_IDS = new Set(["import", "export", "test"]);
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function checkId(id: string): void {
  if (CONTROL_CHARS.test(id)) throw bad("id must not contain control characters");
  if (RESERVED_IDS.has(id)) throw bad(`"${id}" is a reserved word and cannot be used as an id`);
}
const YAML_COLLECTIONS = new Set(["sources", "schemas", "rules"]);

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
const bad = (message: string, extra?: Record<string, unknown>): HttpError => new HttpError(400, message, extra);

function sendYaml(res: http.ServerResponse, text: string): void {
  res.writeHead(200, { "content-type": "application/yaml", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readText(req: http.IncomingMessage, res: http.ServerResponse): Promise<string | undefined> {
  const declared = Number(req.headers["content-length"]);
  const tooLarge = (): undefined => {
    const payload = JSON.stringify({ error: "payload too large" });
    res.writeHead(413, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
      connection: "close",
    });
    res.end(payload, () => req.destroy());
    return undefined;
  };
  if (Number.isFinite(declared) && declared > MAX_CONFIG_BYTES) return tooLarge();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on("data", (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > MAX_CONFIG_BYTES) {
        done = true;
        chunks.length = 0;
        resolve(tooLarge());
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!done) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (e) => (done ? undefined : reject(e)));
  });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw bad("request body is not valid JSON");
  }
}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function validateEntity(kind: Kind, body: unknown): string {
  if (!isObj(body)) throw bad(`request body must be a JSON object (a ${kind})`);
  let id: string;
  try {
    id = entityId(kind, body);
  } catch (e) {
    throw bad(e instanceof Error ? e.message : String(e));
  }
  // Preference ids ("person:p1") are derived and never used as a path segment.
  if (kind !== "preference") checkId(id);
  return id;
}

function decode(s: string): string {
  let id: string;
  try {
    id = decodeURIComponent(s);
  } catch {
    throw bad("bad id in path");
  }
  if (CONTROL_CHARS.test(id)) throw bad("id must not contain control characters");
  return id;
}

async function handleCrud(
  store: ConfigStore,
  kind: Kind,
  method: string,
  id: string | undefined,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  if (id === undefined) {
    if (method === "GET") return send(res, 200, await store.list(kind)), true;
    if (method === "POST") {
      const text = await readText(req, res);
      if (text === undefined) return true;
      const body = parseJson(text);
      const bodyId = validateEntity(kind, body);
      if ((await store.get(kind, bodyId)) !== undefined) {
        throw new HttpError(409, `${kind} already exists: ${bodyId}`);
      }
      await store.upsert(kind, body as never);
      return send(res, 201, body), true;
    }
    return false;
  }
  if (method === "GET") {
    const e = await store.get(kind, id);
    if (e === undefined) throw new HttpError(404, `${kind} not found: ${id}`);
    return send(res, 200, e), true;
  }
  if (method === "PUT") {
    const text = await readText(req, res);
    if (text === undefined) return true;
    const body = parseJson(text);
    const bodyId = validateEntity(kind, body);
    if (bodyId !== id) throw bad(`id in the body (${bodyId}) does not match id in the path (${id})`);
    if ((await store.get(kind, id)) === undefined) throw new HttpError(404, `${kind} not found: ${id}`);
    let entity = body as Record<string, unknown>;
    if (kind === "person" && entity.starredFilters === undefined) {
      // Starred filters live on the person; a replace without them must not wipe them.
      const old = (await store.get("person", id)) as Record<string, unknown> | undefined;
      if (old?.starredFilters !== undefined) entity = { ...entity, starredFilters: old.starredFilters };
    }
    await store.upsert(kind, entity as never);
    return send(res, 200, entity), true;
  }
  if (method === "DELETE") {
    if (!(await store.delete(kind, id))) throw new HttpError(404, `${kind} not found: ${id}`);
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}

async function handlePreferences(
  store: ConfigStore,
  owner: "person" | "group",
  id: string,
  method: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  if (method !== "GET" && method !== "PUT") return false;
  if ((await store.get(owner, id)) === undefined) throw new HttpError(404, `${owner} not found: ${id}`);
  const key = `${owner}:${id}`;
  if (method === "GET") {
    const p = await store.get("preference", key);
    return send(res, 200, p ?? { ownerType: owner, ownerId: id, rules: [] }), true;
  }
  const text = await readText(req, res);
  if (text === undefined) return true;
  const body = parseJson(text);
  if (!isObj(body)) throw bad("request body must be a JSON object (a preference)");
  if (body.ownerType !== undefined && body.ownerType !== owner) throw bad(`ownerType must be "${owner}"`);
  if (body.ownerId !== undefined && body.ownerId !== id) throw bad("ownerId does not match id in the path");
  if (!Array.isArray(body.rules)) throw bad('preference needs a "rules" array');
  for (const r of body.rules) {
    if (!isObj(r) || !isObj(r.when) || !Array.isArray(r.channels)) {
      throw bad('each preference rule needs a "when" filter and a "channels" array');
    }
  }
  if (body.quietHours !== undefined && !isObj(body.quietHours)) throw bad('"quietHours" must be an object');
  const pref = { ...body, ownerType: owner, ownerId: id } as unknown as Preference;
  await store.upsert("preference", pref);
  return send(res, 200, pref), true;
}

async function handleStarred(
  store: ConfigStore,
  id: string,
  method: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  if (method !== "GET" && method !== "PUT") return false;
  const person = (await store.get("person", id)) as (Record<string, unknown> & { id: string }) | undefined;
  if (person === undefined) throw new HttpError(404, `person not found: ${id}`);
  if (method === "GET") return send(res, 200, person.starredFilters ?? []), true;
  const text = await readText(req, res);
  if (text === undefined) return true;
  const body = parseJson(text);
  if (!Array.isArray(body)) throw bad("request body must be a JSON array of starred filters");
  const list: StarredFilter[] = body.map((f, i) => {
    if (!isObj(f) || typeof f.id !== "string" || f.id === "" || typeof f.name !== "string" || !isObj(f.filter)) {
      throw bad(`starred filter ${i} needs a string id, a string name and a filter`);
    }
    if (f.personId !== undefined && f.personId !== id) throw bad(`starred filter ${i} belongs to another person`);
    return { ...f, personId: id } as unknown as StarredFilter;
  });
  await store.upsert("person", { ...person, starredFilters: list } as never);
  return send(res, 200, list), true;
}

async function handleYaml(
  store: ConfigStore,
  kind: Kind,
  id: string | undefined,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  if (id !== undefined) {
    if (req.method !== "GET") return false;
    if ((await store.get(kind, id)) === undefined) throw new HttpError(404, `${kind} not found: ${id}`);
    return sendYaml(res, await exportYaml(store, kind, id)), true;
  }
  if (req.method !== "POST") return false;
  const text = await readText(req, res);
  if (text === undefined) return true;
  let value: unknown;
  try {
    value = fromYaml(text);
  } catch (e) {
    throw bad(e instanceof Error ? e.message : String(e));
  }
  validateEntity(kind, value);
  return send(res, 200, await importYaml(store, kind, text)), true;
}

/** Step actions the worker can run (createDefaultActions in @alerting/runbooks). */
const STEP_ACTIONS = new Set(["http", "escalate", "wait"]);

/** Id of the one YAML runbook a rule can own (written from the alert page). */
export const ruleRunbookId = (ruleId: string): string => `rule-${ruleId}`;

/**
 * GET/PUT/DELETE /api/rules/{id}/runbook: the rule's own runbook, written as YAML. PUT replaces it.
 * id and matches are always set by the server so the runbook belongs to exactly this rule.
 */
async function handleRuleRunbook(
  store: ConfigStore,
  ruleId: string,
  method: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  checkId(ruleId);
  if ((await store.get("rule", ruleId)) === undefined) throw new HttpError(404, `rule not found: ${ruleId}`);
  const rbId = ruleRunbookId(ruleId);
  if (method === "GET") {
    const rb = await store.get("runbook", rbId);
    if (rb === undefined) throw new HttpError(404, "this rule has no runbook yet");
    return send(res, 200, { runbook: rb, yaml: editableYaml(rb as unknown as Record<string, unknown>) }), true;
  }
  if (method === "DELETE") {
    await store.delete("runbook", rbId);
    res.writeHead(204).end();
    return true;
  }
  const text = await readText(req, res);
  if (text === undefined) return true;
  let value: unknown;
  try {
    value = fromYaml(text);
  } catch (e) {
    throw bad(e instanceof Error ? e.message : String(e));
  }
  if (!isObj(value)) throw bad("the YAML must be a runbook object (name, type, content or steps)");
  const candidate = {
    ...value,
    id: rbId,
    ruleId,
    matches: `alert.ruleId = ${JSON.stringify(ruleId)}`,
    type: value.type ?? "text",
  };
  const r = validateRunbook(candidate);
  if (!r.ok) throw bad(r.error);
  const steps = (r.runbook as { steps?: { action: string }[] }).steps ?? [];
  const unknown = steps.findIndex((st) => !STEP_ACTIONS.has(st.action));
  if (unknown !== -1) throw bad(`steps[${unknown}].action must be one of: ${[...STEP_ACTIONS].join(", ")}`);
  if (r.runbook.type === "automation" && steps.length === 0) throw bad("automation runbook needs at least one step");
  await store.upsert("runbook", r.runbook as Runbook);
  return send(res, 200, { runbook: r.runbook, yaml: editableYaml(r.runbook as unknown as Record<string, unknown>) }), true;
}

/** YAML for editing: without the fields the server sets itself. */
function editableYaml(rb: Record<string, unknown>): string {
  const rest = { ...rb };
  delete rest.id;
  delete rest.ruleId;
  delete rest.matches;
  return toYaml(rest);
}

function pickSuggestions(items: readonly string[], prefix: string): string[] {
  const p = prefix.toLowerCase();
  return items.filter((s) => s.toLowerCase().startsWith(p));
}

function suggest(url: URL): string[] {
  const text = url.searchParams.get("text") ?? "";
  const c = url.searchParams.get("cursor");
  const n = c === null || c === "" ? NaN : Number(c);
  const ctx = suggestContext(text, Number.isFinite(n) ? n : text.length);
  switch (ctx.expect) {
    case "field":
      return pickSuggestions([...COMMON_FIELDS, "NOT"], ctx.prefix);
    case "operator":
      return pickSuggestions(OPERATORS.map((o) => o.symbol), ctx.prefix);
    case "value":
      return ctx.field === "alert.severity"
        ? pickSuggestions(Object.keys(SEVERITY_ORDER), ctx.prefix)
        : [];
    default:
      return pickSuggestions(KEYWORDS.filter((k) => k !== "NOT"), ctx.prefix);
  }
}

async function handleFilters(
  action: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  if (action === "suggest") {
    if (req.method !== "GET") return false;
    return send(res, 200, suggest(new URL(req.url ?? "", "http://x"))), true;
  }
  if (req.method !== "POST" || (action !== "parse" && action !== "format")) return false;
  const text = await readText(req, res);
  if (text === undefined) return true;
  const body = parseJson(text);
  if (action === "parse") {
    if (!isObj(body) || typeof body.text !== "string") throw bad('request body must be {"text": string}');
    try {
      const tree = parse(body.text);
      return send(res, 200, { tree }), true;
    } catch (e) {
      if (e instanceof FilterSyntaxError) throw bad(e.message, { position: e.position });
      throw e;
    }
  }
  if (!isObj(body) || body.tree === undefined) throw bad('request body must be {"tree": FilterNode}');
  let tree;
  try {
    tree = validateTree(body.tree);
  } catch (e) {
    throw bad(e instanceof Error ? e.message : String(e));
  }
  return send(res, 200, { text: print(tree) }), true;
}

/** Methods this handler implements for a path shape; anything else is not ours. */
function allowedMethods(coll: string, a: string | undefined, b: string | undefined): string[] {
  if (coll === "filters") {
    if (b !== undefined) return [];
    return a === "suggest" ? ["GET"] : a === "parse" || a === "format" ? ["POST"] : [];
  }
  if (!COLLECTIONS.has(coll) || a === "") return [];
  if (a === undefined) return ["GET", "POST"];
  if (b === undefined) return a === "import" && YAML_COLLECTIONS.has(coll) ? ["POST"] : ["GET", "PUT", "DELETE"];
  if (b === "export") return YAML_COLLECTIONS.has(coll) ? ["GET"] : [];
  if (b === "runbook") return coll === "rules" ? ["GET", "PUT", "DELETE"] : [];
  if (b === "preferences") return coll === "people" || coll === "groups" ? ["GET", "PUT"] : [];
  if (b === "starred-filters") return coll === "people" ? ["GET", "PUT"] : [];
  return [];
}

/** Handles the config routes; resolves false when the request is not one of them. */
export async function handleConfigRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: ConfigDeps,
): Promise<boolean> {
  const path = (req.url ?? "").split("?")[0] ?? "";
  const segs = path.split("/");
  if (segs[0] !== "" || segs[1] !== "api" || segs.length < 3 || segs.length > 5) return false;
  const [, , coll, a, b] = segs as [string, string, string, string | undefined, string | undefined];
  const method = req.method ?? "GET";
  if (!allowedMethods(coll, a, b).includes(method)) return false;

  try {
    if (coll === "filters") return await handleFilters(a!, req, res);
    if (!deps.config) throw new HttpError(503, "config store not configured");
    const store = deps.config;
    const kind = COLLECTIONS.get(coll)!;
    const id = a === undefined ? undefined : decode(a);
    if (b === undefined) {
      if (id === "import" && YAML_COLLECTIONS.has(coll)) return await handleYaml(store, kind, undefined, req, res);
      return await handleCrud(store, kind, method, id, req, res);
    }
    if (b === "export") return await handleYaml(store, kind, id, req, res);
    if (b === "runbook") return await handleRuleRunbook(store, id!, method, req, res);
    if (b === "preferences") {
      return await handlePreferences(store, coll === "people" ? "person" : "group", id!, method, req, res);
    }
    return await handleStarred(store, id!, method, req, res);
  } catch (err) {
    if (res.headersSent) return true;
    if (err instanceof HttpError) {
      send(res, err.status, { error: err.message, ...err.extra });
      return true;
    }
    console.error("config route failed:", err);
    send(res, 500, { error: "internal error" });
    return true;
  }
}
