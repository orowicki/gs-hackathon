import { tryParse } from "@alerting/filter";
import { parse } from "@alerting/ingest";
import { classifyEvent, compileMatch, mapCommonFields } from "@alerting/schemas";
import type { SchemaDef } from "@alerting/schemas";
import { PARSER_TYPES, type JsonObject, type ParserConfig } from "@alerting/shared";
import type { RouteModule } from "../http.js";
import { BodyError, readJsonBody, sendBodyError, sendJson } from "./common.js";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

class BadRequest extends Error {
  constructor(
    message: string,
    readonly position?: number,
  ) {
    super(message);
  }
}

function validateParser(v: unknown): ParserConfig {
  if (!isObject(v)) throw new BadRequest("parser must be an object");
  const type = v.type;
  if (typeof type !== "string" || !(PARSER_TYPES as readonly string[]).includes(type))
    throw new BadRequest(`parser.type must be one of ${PARSER_TYPES.join(", ")}`);
  if (v.pattern !== undefined && typeof v.pattern !== "string") throw new BadRequest("parser.pattern must be a string");
  if (type === "regex") {
    if (typeof v.pattern !== "string" || v.pattern === "") throw new BadRequest("parser.pattern is required for the regex parser");
    try {
      new RegExp(v.pattern);
    } catch (e) {
      throw new BadRequest(e instanceof Error ? e.message : String(e));
    }
  }
  return { type: type as ParserConfig["type"], ...(typeof v.pattern === "string" ? { pattern: v.pattern } : {}) };
}

function validateSchema(v: unknown): SchemaDef {
  if (!isObject(v)) throw new BadRequest("schema must be an object");
  if (typeof v.id !== "string" || v.id === "") throw new BadRequest("schema.id must be a non-empty string");
  if (typeof v.name !== "string") throw new BadRequest("schema.name must be a string");
  if (!isObject(v.mapping)) throw new BadRequest("schema.mapping must be an object");
  if (typeof v.match === "string") {
    const r = tryParse(v.match);
    if (!r.ok) throw new BadRequest(`invalid match filter: ${r.error.message}`, r.error.position);
  }
  const schema = v as unknown as SchemaDef;
  try {
    compileMatch(schema);
  } catch (e) {
    throw new BadRequest(e instanceof Error ? e.message : String(e));
  }
  return schema;
}

export default {
  name: "try",
  order: 5, // before the generic /api/sources/:id and /api/schemas/:id config routes
  async handle({ req, res, path }) {
    if (req.method !== "POST" || (path !== "/api/sources/test" && path !== "/api/schemas/test")) return false;
    try {
      const body = await readJsonBody(req);
      if (path === "/api/sources/test") {
        const parser = validateParser(body.parser);
        if (typeof body.sample !== "string") throw new BadRequest("sample must be a string");
        sendJson(res, 200, { parsed: parse(body.sample, parser) });
      } else {
        const schema = validateSchema(body.schema);
        if (!isObject(body.sample)) throw new BadRequest("sample must be a JSON object");
        const sample = body.sample as JsonObject;
        const matched = classifyEvent(sample, [schema]).schemaId !== null;
        sendJson(res, 200, { matched, common: mapCommonFields(sample, schema) });
      }
    } catch (e) {
      if (e instanceof BodyError) sendBodyError(req, res, e);
      else if (e instanceof BadRequest) sendJson(res, 400, { error: e.message, ...(e.position !== undefined ? { position: e.position } : {}) });
      else throw e;
    }
    return true;
  },
} satisfies RouteModule;
