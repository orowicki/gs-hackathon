import { ROUTES, type RouteDef } from "@alerting/shared";

type Json = Record<string, unknown>;

function operationId(r: RouteDef): string {
  const parts = r.path
    .split("/")
    .filter(Boolean)
    .map((s) => (s.startsWith("{") ? "By" + s.slice(1, -1) : s))
    .map((s) => s.replace(/[^A-Za-z0-9]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : "")))
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1));
  return r.method.toLowerCase() + parts.join("");
}

function body(desc: string): Json {
  return { content: { "application/json": { schema: { type: "object", description: desc } } } };
}

function operation(r: RouteDef): Json {
  const params = [...r.path.matchAll(/\{(\w+)\}/g)].map((m) => ({
    name: m[1],
    in: "path",
    required: true,
    schema: { type: "string" },
  }));
  const op: Json = {
    operationId: operationId(r),
    summary: r.summary,
    tags: [r.tag],
    responses: {
      "200": {
        description: r.response ?? "OK",
        ...(r.response ? body(r.response) : {}),
      },
    },
  };
  if (params.length) op.parameters = params;
  if (r.request) op.requestBody = { required: true, ...body(r.request) };
  return op;
}

/** OpenAPI 3.1 document generated from the shared ROUTES list (bodies are stubs). */
export function buildOpenApi(): Json {
  const paths: Record<string, Json> = {};
  for (const r of ROUTES) (paths[r.path] ??= {})[r.method.toLowerCase()] = operation(r);
  return {
    openapi: "3.1.0",
    info: { title: "Alerting API", version: "0.0.0" },
    paths,
  };
}
