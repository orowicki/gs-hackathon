import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
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

  it("docs/api.md is up to date", () => {
    const current = readFileSync(new URL("../../../docs/api.md", import.meta.url), "utf8");
    expect(current === renderApiReference(doc), "docs/api.md is out of date: run `just docs-api`").toBe(true);
  });
});

// describe("handler conformance") -- PLACEHOLDER: a later task adds handler-vs-schema conformance tests here.
