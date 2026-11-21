/** Every HTTP route of the API. The OpenAPI document is generated from this list. */
export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface RouteDef {
  method: HttpMethod;
  /** OpenAPI form: path params in {braces}. */
  path: string;
  summary: string;
  tag: string;
  /** Type names from @alerting/shared (documentation only). */
  request?: string;
  response?: string;
}

function crud(tag: string, base: string, type: string, plural: string): RouteDef[] {
  return [
    { method: "GET", path: base, summary: `List ${plural}`, tag, response: `${type}[]` },
    { method: "POST", path: base, summary: `Create a ${type}`, tag, request: type, response: type },
    { method: "GET", path: `${base}/{id}`, summary: `Get a ${type}`, tag, response: type },
    { method: "PUT", path: `${base}/{id}`, summary: `Replace a ${type}`, tag, request: type, response: type },
    { method: "DELETE", path: `${base}/{id}`, summary: `Delete a ${type}`, tag },
  ];
}

export const ROUTES: RouteDef[] = [
  { method: "GET", path: "/health", summary: "Liveness and dependency check", tag: "system" },
  { method: "GET", path: "/api/openapi.json", summary: "This OpenAPI document", tag: "system" },

  { method: "POST", path: "/ingest/{sourceId}", summary: "Ingest one JSON object, a JSON array or NDJSON into an http source", tag: "ingest", request: "JsonObject | JsonObject[] | NDJSON" },
  { method: "GET", path: "/api/sources/{id}/preview", summary: "Live preview of incoming raw and parsed messages (SSE)", tag: "sources", response: "Event (text/event-stream)" },

  ...crud("sources", "/api/sources", "Source", "sources"),
  ...crud("schemas", "/api/schemas", "Schema", "schemas"),
  ...crud("rules", "/api/rules", "Rule", "rules"),
  ...crud("people", "/api/people", "Person", "people"),
  ...crud("groups", "/api/groups", "Group", "groups"),
  ...crud("runbooks", "/api/runbooks", "Runbook", "runbooks"),

  { method: "GET", path: "/api/people/{id}/preferences", summary: "Get a person's notification preferences", tag: "preferences", response: "Preference" },
  { method: "PUT", path: "/api/people/{id}/preferences", summary: "Set a person's notification preferences", tag: "preferences", request: "Preference", response: "Preference" },
  { method: "GET", path: "/api/groups/{id}/preferences", summary: "Get a group's notification preferences", tag: "preferences", response: "Preference" },
  { method: "PUT", path: "/api/groups/{id}/preferences", summary: "Set a group's notification preferences", tag: "preferences", request: "Preference", response: "Preference" },

  { method: "POST", path: "/api/schemas/test", summary: "Try a schema/mapping against a pasted sample; returns the mapped common fields", tag: "schemas", request: "{ schema: Schema; sample: JsonObject }", response: "{ matched: boolean; common: Partial<CommonFields> }" },
  { method: "POST", path: "/api/sources/test", summary: "Try a parser on a sample line; returns the parsed fields", tag: "sources", request: "{ parser: ParserConfig; sample: string }", response: "{ parsed: JsonObject }" },
  { method: "GET", path: "/api/people/{id}/starred-filters", summary: "List a person's starred filters", tag: "filters", response: "StarredFilter[]" },
  { method: "PUT", path: "/api/people/{id}/starred-filters", summary: "Replace a person's starred filters", tag: "filters", request: "StarredFilter[]", response: "StarredFilter[]" },
  { method: "GET", path: "/api/events", summary: "List stored events (filter, limit, before)", tag: "events", response: "Event[]" },
  { method: "GET", path: "/api/events/recent", summary: "Most recent events (for autocomplete and previews)", tag: "events", response: "Event[]" },
  { method: "POST", path: "/api/events/test-filter", summary: "Count recent events matching a filter", tag: "events", request: "{ filter: Filter }", response: "{ matched: number; total: number }" },

  { method: "POST", path: "/api/filters/parse", summary: "Parse and validate a filter text; returns the JSON tree or an error with position", tag: "filters", request: "{ text: string }", response: "{ tree: FilterNode } | FilterParseError" },
  { method: "POST", path: "/api/filters/format", summary: "Render a filter tree back to text", tag: "filters", request: "{ tree: FilterNode }", response: "{ text: string }" },
  { method: "GET", path: "/api/filters/suggest", summary: "Autocomplete field names, operators and values", tag: "filters", response: "string[]" },

  { method: "GET", path: "/api/alerts", summary: "List alerts (filter, state, limit, before)", tag: "alerts", response: "Alert[]" },
  { method: "GET", path: "/api/alerts/{id}", summary: "Get an alert with its event, runbooks and suggestions", tag: "alerts", response: "Alert" },
  { method: "GET", path: "/api/alerts/{id}/runbook-runs", summary: "Runbook run state per step of an alert", tag: "runbooks", response: "RunbookRun[]" },
  { method: "GET", path: "/api/approvals", summary: "Pending runbook step approvals", tag: "runbooks", response: "PendingApproval[]" },
  { method: "GET", path: "/api/audit", summary: "Global audit log (filter by query: alertId, actor, action, before, limit)", tag: "alerts", response: "AuditEntry[]" },
  { method: "POST", path: "/api/alerts/{id}/ack", summary: "Acknowledge an alert", tag: "alerts", response: "Alert" },
  { method: "POST", path: "/api/alerts/{id}/resolve", summary: "Resolve an alert", tag: "alerts", response: "Alert" },
  { method: "GET", path: "/api/alerts/{id}/audit", summary: "Audit log of an alert", tag: "alerts", response: "AuditEntry[]" },
  { method: "POST", path: "/api/alerts/{id}/runbook-steps/{stepIndex}/approve", summary: "Approve a runbook step awaiting approval", tag: "runbooks", response: "AuditEntry" },

  { method: "POST", path: "/api/alerts/{id}/suggestions", summary: "Suggest a change (attached to the alert's rule)", tag: "suggestions", request: "{ text: string }", response: "Suggestion" },
  { method: "POST", path: "/api/rules/{id}/suggestions", summary: "Suggest a change to a rule", tag: "suggestions", request: "{ text: string }", response: "Suggestion" },
  { method: "GET", path: "/api/rules/{id}/suggestions", summary: "List suggestions for a rule", tag: "suggestions", response: "Suggestion[]" },
  { method: "POST", path: "/api/suggestions/{id}/accept", summary: "Accept a suggestion", tag: "suggestions", response: "Suggestion" },
  { method: "POST", path: "/api/suggestions/{id}/dismiss", summary: "Dismiss a suggestion", tag: "suggestions", response: "Suggestion" },

  { method: "GET", path: "/api/channels", summary: "Channel status", tag: "channels", response: "ChannelStatus[]" },
  { method: "GET", path: "/api/dead-letters", summary: "List dead-lettered notifications", tag: "channels", response: "DeadLetter[]" },
  { method: "POST", path: "/api/dead-letters/{id}/retry", summary: "Retry a dead letter now", tag: "channels", response: "Notification" },

  { method: "GET", path: "/api/schemas/{id}/export", summary: "Export a schema as YAML", tag: "yaml", response: "application/yaml" },
  { method: "POST", path: "/api/schemas/import", summary: "Import a schema from YAML", tag: "yaml", request: "application/yaml", response: "Schema" },
  { method: "GET", path: "/api/sources/{id}/export", summary: "Export a source as YAML", tag: "yaml", response: "application/yaml" },
  { method: "POST", path: "/api/sources/import", summary: "Import a source from YAML", tag: "yaml", request: "application/yaml", response: "Source" },
  { method: "GET", path: "/api/rules/{id}/export", summary: "Export a rule as YAML", tag: "yaml", response: "application/yaml" },
  { method: "POST", path: "/api/rules/import", summary: "Import a rule from YAML", tag: "yaml", request: "application/yaml", response: "Rule" },

  { method: "GET", path: "/api/stream", summary: "Live push of new and updated alerts (SSE)", tag: "stream", response: "UiPush (text/event-stream)" },
];
