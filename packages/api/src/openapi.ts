import { ROUTES, type RouteDef } from "@alerting/shared";
import { componentSchemas } from "./openapi/components.js";
import { operationExamples } from "./openapi/examples.js";
import { NOT_IMPLEMENTED_NOTE, operationSpecs, type OperationSpec, type ResponseSpec } from "./openapi/operations.js";

type Json = Record<string, unknown>;

const ERROR_REF = { $ref: "#/components/schemas/Error" };
const ERROR_TEXT: Record<number, string> = {
  400: "Bad request (invalid id, body, filter or parameter)",
  401: "Not signed in",
  403: "The account is not allowed to do this",
  404: "Not found",
  409: "Conflict with the current state",
  413: "Payload too large",
  500: "Internal error",
  503: "Dependency or component not configured",
};

function operationId(r: RouteDef): string {
  const parts = r.path
    .split("/")
    .filter(Boolean)
    .map((s) => (s.startsWith("{") ? "By" + s.slice(1, -1) : s))
    .map((s) => s.replace(/[^A-Za-z0-9]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : "")))
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1));
  return r.method.toLowerCase() + parts.join("");
}

function response(r: ResponseSpec): Json {
  const out: Json = { description: r.description };
  if (r.headers) {
    out.headers = Object.fromEntries(
      Object.entries(r.headers).map(([k, description]) => [k, { description, schema: { type: "string" } }]),
    );
  }
  if (r.mediaType && r.schema) out.content = { [r.mediaType]: { schema: r.schema } };
  return out;
}

function operation(r: RouteDef, spec: OperationSpec, key: string): Json {
  const parameters: Json[] = [...r.path.matchAll(/\{(\w+)\}/g)].map((m) => {
    const name = m[1]!;
    const o = spec.pathParams?.[name];
    return {
      name,
      in: "path",
      required: true,
      ...(o?.description ? { description: o.description } : {}),
      schema: o?.schema ?? { type: "string" },
    };
  });
  for (const p of spec.query ?? []) {
    parameters.push({
      name: p.name,
      in: "query",
      required: p.required ?? false,
      description: p.description,
      schema: p.schema,
    });
  }

  const responses: Record<string, Json> = {};
  for (const s of [spec.success, ...(spec.alsoSuccess ?? []), ...(spec.failures ?? [])]) {
    responses[String(s.status)] = response(s);
  }
  for (const status of spec.errors) {
    responses[String(status)] ??= {
      description: ERROR_TEXT[status] ?? "Error",
      content: { "application/json": { schema: ERROR_REF } },
    };
  }

  const op: Json = { operationId: operationId(r), summary: r.summary, tags: [r.tag], responses };
  if (spec.notImplemented) {
    op.description = NOT_IMPLEMENTED_NOTE;
    op["x-not-implemented"] = true;
  }
  if (parameters.length) op.parameters = parameters;
  if (spec.request) {
    const examples = operationExamples[key] ?? {};
    const content: Record<string, Json> = {};
    for (const [mediaType, schema] of Object.entries(spec.request.content)) {
      const forMedia = Object.entries(examples).filter(([, e]) => (e.mediaType ?? "application/json") === mediaType);
      content[mediaType] = {
        schema,
        ...(forMedia.length
          ? { examples: Object.fromEntries(forMedia.map(([name, e]) => [name, { summary: e.summary, value: e.value }])) }
          : {}),
      };
    }
    op.requestBody = {
      required: spec.request.required,
      ...(spec.request.description ? { description: spec.request.description } : {}),
      content,
    };
  }
  return op;
}

/** OpenAPI 3.1 document generated from the shared ROUTES list plus the specs in ./openapi. */
export function buildOpenApi(): Json {
  const paths: Record<string, Json> = {};
  for (const r of ROUTES) {
    const key = `${r.method} ${r.path}`;
    const spec = operationSpecs[key];
    if (!spec) throw new Error(`openapi: no operation spec for ${key}`);
    (paths[r.path] ??= {})[r.method.toLowerCase()] = operation(r, spec, key);
  }
  return {
    openapi: "3.1.0",
    info: { title: "Alerting API", version: "0.0.0" },
    paths,
    components: { schemas: componentSchemas },
  };
}
