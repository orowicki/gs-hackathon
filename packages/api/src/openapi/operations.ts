/** Per-operation OpenAPI details (query params, bodies, responses), keyed "METHOD /path" exactly as in ROUTES. */
type Schema = Record<string, unknown>;

export interface ParamSpec {
  name: string;
  schema: Schema;
  required?: boolean;
  description: string;
}

export interface BodySpec {
  required: boolean;
  description?: string;
  /** media type -> schema */
  content: Record<string, Schema>;
}

export interface ResponseSpec {
  status: number;
  description: string;
  /** Omit for bodiless responses (204). */
  mediaType?: string;
  schema?: Schema;
  /** Response headers: name -> description (string schema). */
  headers?: Record<string, string>;
}

export interface OperationSpec {
  query?: ParamSpec[];
  /** Path parameter overrides (default: string). */
  pathParams?: Record<string, { schema: Schema; description?: string }>;
  request?: BodySpec;
  success: ResponseSpec;
  /** Further non-error responses (e.g. 202). */
  alsoSuccess?: ResponseSpec[];
  /** Statuses answered with the Error schema. */
  errors: number[];
  /** Non-Error responses for a failure status (e.g. /health 503). */
  failures?: ResponseSpec[];
  /** Route is listed in ROUTES but has no handler yet (the server answers 404). */
  notImplemented?: boolean;
}

/** Prefix of the description of operations that are documented but not served yet. */
export const NOT_IMPLEMENTED_NOTE = "Not implemented yet (issue #108): the server currently answers 404.";

const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const list = (name: string): Schema => ({ type: "array", items: ref(name) });
const JSON_T = "application/json";
const YAML_T = "application/yaml";
const SSE_T = "text/event-stream";

const json = (status: number, description: string, schema?: Schema, headers?: Record<string, string>): ResponseSpec => ({
  status,
  description,
  mediaType: JSON_T,
  ...(schema ? { schema } : {}),
  ...(headers ? { headers } : {}),
});
const body = (name: string, required = true, description?: string): BodySpec => ({
  required,
  ...(description ? { description } : {}),
  content: { [JSON_T]: ref(name) },
});
const yamlBody = (name: string): BodySpec => ({
  required: true,
  description: `A ${name} as YAML text (same shape and validation as the JSON form).`,
  content: { [YAML_T]: { type: "string" } },
});
const yamlOut = (name: string): ResponseSpec => ({
  status: 200,
  description: `The ${name} as YAML text`,
  mediaType: YAML_T,
  schema: { type: "string" },
});
const q = (name: string, schema: Schema, description: string, required = false): ParamSpec => ({
  name,
  schema,
  description,
  required,
});

/** Handlers never answer 400 for `limit`: non-numeric values fall back to the default, others are clamped. */
const limitParam = (def: number, max: number): ParamSpec =>
  q("limit", { type: "integer", default: def }, `Page size (default ${def}); clamped to 1..${max}, a non-numeric value falls back to the default`);

/** Config store routes can answer 503 when the store is not wired. */
const CFG = [503];

function crud(type: string, plural: string, base: string): Record<string, OperationSpec> {
  const cap = type;
  return {
    [`GET ${base}`]: { success: json(200, `All ${plural}`, list(cap)), errors: CFG },
    [`POST ${base}`]: {
      request: body(cap, true, `The id must be unique; "import", "export" and "test" are reserved ids.`),
      success: json(201, `The created ${cap} (echo of the request body)`, ref(cap)),
      errors: [400, 409, 413, ...CFG],
    },
    [`GET ${base}/{id}`]: { success: json(200, `The ${cap}`, ref(cap)), errors: [400, 404, ...CFG] },
    [`PUT ${base}/{id}`]: {
      request: body(cap, true, "The id in the body must equal the id in the path."),
      success: json(200, `The replaced ${cap}`, ref(cap)),
      errors: [400, 404, 413, ...CFG],
    },
    [`DELETE ${base}/{id}`]: { success: { status: 204, description: `${cap} deleted` }, errors: [400, 404, ...CFG] },
  };
}

const prefs = (owner: string, base: string): Record<string, OperationSpec> => ({
  [`GET ${base}/{id}/preferences`]: {
    success: json(200, `Stored preference, or an empty one (rules: []) when none is stored`, ref("Preference")),
    errors: [400, 404, ...CFG],
  },
  [`PUT ${base}/{id}/preferences`]: {
    request: body("Preference", true, `ownerType/ownerId are optional but, when present, must match the ${owner} in the path.`),
    success: json(200, "The stored preference", ref("Preference")),
    errors: [400, 404, 413, ...CFG],
  },
});

const cursor = (what: string): string => `Opaque cursor from the x-next-before response header of the previous page (${what})`;
const NEXT = { "x-next-before": "Cursor for the next page; present when more rows may exist" };

export const operationSpecs: Record<string, OperationSpec> = {
  "GET /health": {
    success: json(200, "Postgres and Redis are reachable", ref("Health")),
    failures: [json(503, "A dependency check failed", ref("Health"))],
    errors: [],
  },
  "GET /api/openapi.json": { success: json(200, "This OpenAPI document", { type: "object" }), errors: [] },

  "POST /ingest/{sourceId}": {
    request: {
      required: true,
      description: "One JSON object, a JSON array of objects, or NDJSON (one object per line).",
      content: {
        [JSON_T]: { oneOf: [ref("JsonObject"), { type: "array", items: ref("JsonObject") }] },
        "application/x-ndjson": { type: "string", description: "One JSON object per line" },
      },
    },
    success: json(202, "Messages accepted for processing", ref("IngestResult")),
    errors: [400, 404, 413, 500],
  },
  "GET /api/sources/{id}/preview": {
    notImplemented: true,
    success: {
      status: 200,
      description: "Server-sent events: each `data:` line is JSON with the raw and parsed message",
      mediaType: SSE_T,
      schema: { type: "string" },
    },
    errors: [404],
  },

  ...crud("Source", "sources", "/api/sources"),
  ...crud("Schema", "schemas", "/api/schemas"),
  ...crud("Rule", "rules", "/api/rules"),
  ...crud("Person", "people", "/api/people"),
  ...crud("Group", "groups", "/api/groups"),
  ...crud("Runbook", "runbooks", "/api/runbooks"),
  ...prefs("person", "/api/people"),
  ...prefs("group", "/api/groups"),

  "POST /api/schemas/test": {
    notImplemented: true,
    request: body("SchemaTestRequest"),
    success: json(200, "Whether the sample matched and the mapped common fields", ref("SchemaTestResponse")),
    errors: [400],
  },
  "POST /api/sources/test": {
    notImplemented: true,
    request: body("SourceTestRequest"),
    success: json(200, "The parsed fields", ref("SourceTestResponse")),
    errors: [400],
  },
  "GET /api/people/{id}/starred-filters": {
    success: json(200, "The person's starred filters (empty list when none)", list("StarredFilter")),
    errors: [400, 404, ...CFG],
  },
  "PUT /api/people/{id}/starred-filters": {
    request: {
      required: true,
      description: "personId is optional but must match the path when present; each filter must be a JSON filter tree.",
      content: { [JSON_T]: list("StarredFilter") },
    },
    success: json(200, "The stored starred filters", list("StarredFilter")),
    errors: [400, 404, 413, ...CFG],
  },
  "GET /api/events": {
    notImplemented: true,
    query: [
      q("filter", { type: "string" }, "Filter expression text"),
      limitParam(50, 200),
      q("before", { type: "string" }, cursor("events")),
    ],
    success: json(200, "Stored events, newest first", list("Event"), NEXT),
    errors: [400],
  },
  "GET /api/events/recent": {
    query: [limitParam(50, 1000)],
    success: json(200, "Most recent events, newest first", list("Event")),
    errors: [],
  },
  "POST /api/events/test-filter": {
    query: [q("limit", { type: "integer", minimum: 1, maximum: 1000 }, "How many recent events to test (default 1000); the body field `limit` takes precedence")],
    request: body("TestFilterRequest"),
    success: json(200, "Number of recent events matching the filter", ref("TestFilterResponse")),
    errors: [400, 413],
  },

  "POST /api/filters/parse": {
    request: body("FilterTextRequest"),
    success: json(200, "The parsed filter tree", ref("FilterParseResponse")),
    errors: [400],
  },
  "POST /api/filters/format": {
    request: body("FilterFormatRequest"),
    success: json(200, "The filter as text", ref("FilterFormatResponse")),
    errors: [400],
  },
  "GET /api/filters/suggest": {
    query: [
      q("text", { type: "string" }, "Filter text typed so far"),
      q("cursor", { type: "integer", minimum: 0 }, "Caret position in `text` (default: end of text)"),
    ],
    success: json(200, "Completions for the caret position", { type: "array", items: { type: "string" } }),
    errors: [],
  },

  "GET /api/alerts": {
    query: [
      q("filter", { type: "string" }, "Filter expression text (takes precedence over `tree`)"),
      q("tree", { type: "string" }, "Filter tree as a JSON-encoded string"),
      q("state", { $ref: "#/components/schemas/AlertState" }, "Only alerts in this state"),
      limitParam(50, 200),
      q("before", { type: "string" }, cursor("alerts")),
    ],
    success: json(200, "Alerts, newest activity first", list("Alert"), NEXT),
    errors: [400],
  },
  "GET /api/alerts/{id}": { success: json(200, "The alert with its event and suggestions", ref("AlertDetail")), errors: [400, 404] },
  "GET /api/alerts/{id}/runbook-runs": { success: json(200, "Runs of matching runbooks for the alert", list("RunbookRun")), errors: [400] },
  "GET /api/approvals": { success: json(200, "Steps awaiting approval", list("PendingApproval")), errors: [] },
  "GET /api/audit": {
    query: [
      q("alertId", { type: "string" }, "Only entries of this alert"),
      q("actor", { type: "string" }, "Only entries by this actor"),
      q("action", { type: "string" }, "Only this action"),
      q("before", { type: "string" }, cursor("audit entries") + " or an ISO timestamp"),
      limitParam(50, 200),
    ],
    success: json(200, "Audit entries, newest first", list("AuditEntry"), NEXT),
    errors: [400],
  },
  "POST /api/alerts/{id}/ack": {
    request: body("AlertTransitionRequest", false),
    success: json(200, "The acknowledged alert", ref("Alert")),
    errors: [400, 404, 409, 413],
  },
  "POST /api/alerts/{id}/resolve": {
    request: body("AlertTransitionRequest", false),
    success: json(200, "The resolved alert", ref("Alert")),
    errors: [400, 404, 409, 413],
  },
  "GET /api/alerts/{id}/audit": { success: json(200, "Audit log of the alert", list("AuditEntry")), errors: [400, 404] },
  "POST /api/alerts/{id}/runbook-steps/{stepIndex}/approve": {
    pathParams: { stepIndex: { schema: { type: "integer", minimum: 0 }, description: "Zero-based index of the step" } },
    query: [
      q("runbookId", { type: "string" }, "Runbook id (alternative to the body field)"),
      q("actor", { type: "string" }, "Approver (alternative to the body field)"),
    ],
    request: body("ApproveStepRequest", false),
    success: json(200, "The run after the step was approved or skipped", ref("RunbookRun")),
    alsoSuccess: [json(202, "Approved; the continuation is still running", ref("RunbookRun"))],
    errors: [400, 404, 409, 413],
  },

  "POST /api/alerts/{id}/suggestions": {
    request: body("SuggestionRequest"),
    success: json(201, "The created suggestion", ref("Suggestion")),
    errors: [400, 404, 413],
  },
  "POST /api/rules/{id}/suggestions": {
    request: body("SuggestionRequest"),
    success: json(201, "The created suggestion", ref("Suggestion")),
    errors: [400, 413],
  },
  "GET /api/rules/{id}/suggestions": {
    query: [q("status", { type: "string", enum: ["open", "accepted", "dismissed"] }, "Only suggestions with this status")],
    success: json(200, "Suggestions of the rule", list("Suggestion")),
    errors: [400],
  },
  "POST /api/suggestions/{id}/accept": { success: json(200, "The accepted suggestion", ref("Suggestion")), errors: [400, 404, 409] },
  "POST /api/suggestions/{id}/dismiss": { success: json(200, "The dismissed suggestion", ref("Suggestion")), errors: [400, 404, 409] },

  "GET /api/channels": { success: json(200, "Status per channel", list("ChannelStatus")), errors: [503] },
  "GET /api/dead-letters": { success: json(200, "Dead-lettered notifications", list("DeadLetter")), errors: [503] },
  "POST /api/dead-letters/{id}/retry": { success: json(200, "The re-queued notification", ref("Notification")), errors: [400, 404, 503] },
  "GET /api/source-types": { success: json(200, "Source plugin types and the parser config schema", ref("SourceTypesResponse")), errors: [] },

  "GET /api/schemas/{id}/export": { success: yamlOut("schema"), errors: [400, 404, ...CFG] },
  "POST /api/schemas/import": {
    request: yamlBody("Schema"),
    success: json(200, "The imported (upserted) schema", ref("Schema")),
    errors: [400, 413, ...CFG],
  },
  "GET /api/sources/{id}/export": { success: yamlOut("source"), errors: [400, 404, ...CFG] },
  "POST /api/sources/import": {
    request: yamlBody("Source"),
    success: json(200, "The imported (upserted) source", ref("Source")),
    errors: [400, 413, ...CFG],
  },
  "GET /api/rules/{id}/export": { success: yamlOut("rule"), errors: [400, 404, ...CFG] },
  "POST /api/rules/import": {
    request: yamlBody("Rule"),
    success: json(200, "The imported (upserted) rule", ref("Rule")),
    errors: [400, 413, ...CFG],
  },

  "GET /api/stream": {
    success: {
      status: 200,
      description: "Server-sent events; each `data:` line is a JSON UiPush message",
      mediaType: SSE_T,
      schema: { type: "string" },
    },
    errors: [503],
  },
};
