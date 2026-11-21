// Renders docs/api.md from the OpenAPI document served at /api/openapi.json.
//
// Usage (Node 22.6+):  just docs-api
//   = npm run build -w @alerting/api && node --experimental-strip-types --no-warnings scripts/docs/api-reference.ts
// `--check` exits 1 when docs/api.md is out of date.
// The document is loaded from the BUILT package (packages/api/dist/openapi.js) because strip-types
// cannot resolve the `.js`-suffixed TypeScript imports of the sources. Keep this file free of
// non-erasable TS syntax (enums, parameter properties, namespaces).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

type Json = Record<string, unknown>;

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];
const REF_PREFIX = "#/components/schemas/";

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const obj = (v: unknown): Json => (isObj(v) ? v : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const esc = (s: string): string => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const anchor = (name: string): string => "schema-" + name.toLowerCase().replace(/[^a-z0-9]+/g, "-");

function refName(ref: string): string {
  return ref.startsWith(REF_PREFIX) ? ref.slice(REF_PREFIX.length) : ref;
}

/** Compact one-line type rendering of a schema; $refs become links to the Schemas section. */
export function schemaType(s: unknown): string {
  if (!isObj(s)) return s === true ? "any" : "unknown";
  if (typeof s.$ref === "string") {
    const n = refName(s.$ref);
    return s.$ref.startsWith(REF_PREFIX) ? `[${n}](#${anchor(n)})` : n;
  }
  if (Array.isArray(s.enum)) return s.enum.map((v) => JSON.stringify(v)).join(" \\| ");
  if ("const" in s) return JSON.stringify(s.const);
  for (const k of ["oneOf", "anyOf"]) {
    if (Array.isArray(s[k])) return (s[k] as unknown[]).map(schemaType).join(" \\| ");
  }
  if (Array.isArray(s.allOf)) return (s.allOf as unknown[]).map(schemaType).join(" & ");
  const t = s.type;
  if (Array.isArray(t)) return t.map(String).join(" \\| ");
  if (t === "array") return `${schemaType(s.items)}[]`;
  if (t === "object" || isObj(s.properties)) {
    if (isObj(s.properties) && Object.keys(s.properties).length) {
      const req = Array.isArray(s.required) ? s.required : [];
      const parts = Object.keys(s.properties).map(
        (k) => `${k}${req.includes(k) ? "" : "?"}: ${schemaType(obj(s.properties)[k])}`,
      );
      return `{ ${parts.join(", ")} }`;
    }
    if (isObj(s.additionalProperties)) return `map<string, ${schemaType(s.additionalProperties)}>`;
    return "object";
  }
  if (typeof t === "string") return s.format ? `${t} (${String(s.format)})` : t;
  return "any";
}

function table(head: string[], rows: string[][]): string[] {
  return [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
    "",
  ];
}

function renderExample(mediaType: string, ex: unknown): string[] {
  const value = obj(ex).value;
  if (typeof value === "string") {
    const lang = mediaType.includes("yaml") ? "yaml" : "";
    return ["```" + lang, value.replace(/\n$/, ""), "```", ""];
  }
  return ["```json", JSON.stringify(value, null, 2), "```", ""];
}

function renderOperation(method: string, path: string, op: Json): string[] {
  const out: string[] = [`### ${method.toUpperCase()} \`${path}\``, ""];
  if (op.summary) out.push(str(op.summary), "");
  if (op.description) out.push(str(op.description), "");

  const params = Array.isArray(op.parameters) ? (op.parameters as unknown[]).map(obj) : [];
  if (params.length) {
    out.push("**Parameters**", "");
    out.push(
      ...table(
        ["name", "in", "type", "required", "description"],
        params.map((p) => [
          `\`${str(p.name)}\``,
          str(p.in),
          schemaType(p.schema),
          p.required ? "yes" : "no",
          esc(str(p.description)),
        ]),
      ),
    );
  }

  const rb = obj(op.requestBody);
  const rbContent = obj(rb.content);
  if (Object.keys(rbContent).length) {
    out.push(`**Request body**${rb.required ? " (required)" : ""}`, "");
    if (rb.description) out.push(str(rb.description), "");
    for (const mt of Object.keys(rbContent)) {
      const media = obj(rbContent[mt]);
      out.push(`Media type \`${mt}\`: ${schemaType(media.schema)}`, "");
      const examples = obj(media.examples);
      for (const name of Object.keys(examples)) {
        const ex = obj(examples[name]);
        out.push(`Example \`${name}\`${ex.summary ? ` (${str(ex.summary)})` : ""}:`, "");
        out.push(...renderExample(mt, ex));
      }
    }
  }

  const responses = obj(op.responses);
  const rows: string[][] = [];
  for (const status of Object.keys(responses).sort()) {
    const r = obj(responses[status]);
    const content = obj(r.content);
    const mts = Object.keys(content);
    if (!mts.length) rows.push([status, "", "", esc(str(r.description))]);
    for (const mt of mts) {
      rows.push([status, `\`${mt}\``, schemaType(obj(content[mt]).schema), esc(str(r.description))]);
    }
  }
  if (rows.length) {
    out.push("**Responses**", "");
    out.push(...table(["status", "media type", "schema", "description"], rows));
  }
  return out;
}

export function renderApiReference(doc: Json): string {
  const info = obj(doc.info);
  const out: string[] = [
    `# ${str(info.title) || "API"} reference`,
    "",
    "<!-- GENERATED FILE, do not edit by hand. Regenerate with `just docs-api`. -->",
    "",
    "This page is generated from the OpenAPI document served at `/api/openapi.json`. " +
      "Do not edit it by hand; run `just docs-api` after changing the API.",
    "",
    `OpenAPI ${str(doc.openapi)}, API version ${str(info.version)}.`,
    "",
  ];
  if (info.description) out.push(str(info.description), "");

  const paths = obj(doc.paths);
  const byTag = new Map<string, string[]>();
  for (const path of Object.keys(paths).sort()) {
    const item = obj(paths[path]);
    for (const method of METHODS) {
      if (!isObj(item[method])) continue;
      const op = obj(item[method]);
      const tags = Array.isArray(op.tags) && op.tags.length ? (op.tags as unknown[]).map(String) : ["untagged"];
      const lines = renderOperation(method, path, op);
      for (const t of tags) byTag.set(t, [...(byTag.get(t) ?? []), ...lines]);
    }
  }
  const declared = Array.isArray(doc.tags) ? (doc.tags as unknown[]).map((t) => str(obj(t).name)) : [];
  const tagOrder = [...declared.filter((t) => byTag.has(t)), ...[...byTag.keys()].filter((t) => !declared.includes(t)).sort()];
  for (const tag of tagOrder) {
    out.push(`## ${tag}`, "");
    const tagDesc = Array.isArray(doc.tags) ? (doc.tags as unknown[]).map(obj).find((t) => t.name === tag)?.description : "";
    if (tagDesc) out.push(str(tagDesc), "");
    out.push(...(byTag.get(tag) ?? []));
  }

  const schemas = obj(obj(doc.components).schemas);
  const names = Object.keys(schemas).sort();
  if (names.length) {
    out.push("## Schemas", "");
    for (const n of names) {
      const s = obj(schemas[n]);
      out.push(`<a id="${anchor(n)}"></a>`, "", `### ${n}`, "");
      if (s.description) out.push(str(s.description), "");
      const props = obj(s.properties);
      const req = Array.isArray(s.required) ? s.required : [];
      if (Object.keys(props).length) {
        out.push(
          ...table(
            ["name", "type", "required", "description"],
            Object.keys(props).map((k) => [
              `\`${k}\``,
              schemaType(props[k]),
              req.includes(k) ? "yes" : "no",
              esc(str(obj(props[k]).description)),
            ]),
          ),
        );
      } else {
        out.push(`Type: ${schemaType(s)}`, "");
      }
    }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

async function main(): Promise<void> {
  const distUrl = new URL("../../packages/api/dist/openapi.js", import.meta.url);
  const mod = (await import(distUrl.href)) as { buildOpenApi: () => Json };
  const md = renderApiReference(mod.buildOpenApi());
  const target = new URL("../../docs/api.md", import.meta.url);
  if (process.argv.includes("--check")) {
    let current = "";
    try {
      current = readFileSync(target, "utf8");
    } catch {
      /* missing counts as out of date */
    }
    if (current !== md) {
      console.error("docs/api.md is out of date; run `just docs-api`");
      process.exit(1);
    }
    return;
  }
  writeFileSync(target, md);
  console.log(`wrote ${fileURLToPath(target)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
