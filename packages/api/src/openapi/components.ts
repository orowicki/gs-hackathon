/**
 * JSON Schema (2020-12, as used by OpenAPI 3.1) for every shared type the API accepts or returns.
 * Derived from packages/shared/src/types, adjusted to what the handlers really send/accept:
 * the config store only requires an id, so request schemas stay tolerant (no additionalProperties:false),
 * and optional fields are nullable-tolerant on responses (rows come back from Postgres).
 */
type Schema = Record<string, unknown>;

const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const str = (description?: string): Schema => ({ type: "string", ...(description ? { description } : {}) });
const optStr = (description?: string): Schema => ({ type: ["string", "null"], ...(description ? { description } : {}) });
const arr = (items: Schema): Schema => ({ type: "array", items });
const obj = (properties: Record<string, Schema>, required: string[] = [], extra: Schema = {}): Schema => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  ...extra,
});
const strEnum = (values: string[]): Schema => ({ type: "string", enum: values });
const filter = (): Schema => ref("Filter");
const channels = (): Schema => arr(str());

const commonFieldNames = ["severity", "title", "source", "environment", "dedupKey", "status", "occurredAt"];

export const componentSchemas: Record<string, object> = {
  Error: obj(
    { error: str("Human-readable message"), position: { type: "integer", description: "1-based column of a filter syntax error" } },
    ["error"],
  ),

  Severity: strEnum(["info", "warning", "error", "critical"]),
  AlertState: strEnum(["open", "acknowledged", "resolved"]),
  JsonObject: { type: "object", additionalProperties: true },

  CommonFields: obj({
    severity: ref("Severity"),
    title: str(),
    source: str(),
    environment: str(),
    dedupKey: str(),
    status: strEnum(["firing", "resolved"]),
    occurredAt: { description: "ISO timestamp (or epoch value as mapped)", type: ["string", "number", "null"] },
  }, [], { additionalProperties: true }),

  // ---- filters ----
  FilterValue: { type: ["string", "number"] },
  FilterNode: {
    oneOf: [
      obj({ type: { const: "and" }, children: arr(ref("FilterNode")) }, ["type", "children"]),
      obj({ type: { const: "or" }, children: arr(ref("FilterNode")) }, ["type", "children"]),
      obj({ type: { const: "not" }, child: ref("FilterNode") }, ["type", "child"]),
      obj(
        {
          type: { const: "cmp" },
          field: str("alert.<commonField>, alert.schema or a raw event path such as payload.notional"),
          op: strEnum(["=", "!=", ">", ">=", "<", "<=", "contains", "matches"]),
          value: ref("FilterValue"),
        },
        ["type", "field", "op", "value"],
      ),
      obj({ type: { const: "in" }, field: str(), values: arr(ref("FilterValue")) }, ["type", "field", "values"]),
    ],
  },
  Filter: {
    description: "A filter expression as text (e.g. `alert.severity = critical`) or as the parsed JSON tree.",
    oneOf: [str(), ref("FilterNode")],
  },
  FilterParseError: obj({ message: str(), position: { type: "integer" } }, ["message", "position"]),
  StarredFilter: obj(
    { id: str(), personId: str("Set by the server from the path"), name: str(), filter: ref("FilterNode") },
    ["id", "name", "filter"],
  ),

  // ---- sources ----
  ParserConfig: obj(
    { type: strEnum(["json", "logfmt", "regex", "raw"]), pattern: str("For regex: pattern with named groups") },
    ["type"],
  ),
  SourceBase: obj({ id: str(), name: str(), enabled: { type: "boolean" }, parser: ref("ParserConfig") }, [
    "id",
    "name",
    "enabled",
    "parser",
  ]),
  Source: {
    oneOf: [
      {
        allOf: [
          ref("SourceBase"),
          obj({ type: { const: "http" }, config: { type: "object", description: "No configuration" } }, ["type", "config"]),
        ],
      },
      {
        allOf: [
          ref("SourceBase"),
          obj(
            { type: { const: "file_tail" }, config: obj({ path: str("Path or glob") }, ["path"]) },
            ["type", "config"],
          ),
        ],
      },
      {
        allOf: [
          ref("SourceBase"),
          obj(
            {
              type: { const: "redis_stream" },
              config: obj({ stream: str(), consumerGroup: str() }, ["stream", "consumerGroup"]),
            },
            ["type", "config"],
          ),
        ],
      },
      {
        allOf: [
          ref("SourceBase"),
          obj(
            {
              type: { const: "kafka" },
              config: obj(
                { brokers: str(), topic: str(), groupId: str(), fromBeginning: { type: "boolean" } },
                ["brokers", "topic", "groupId"],
              ),
            },
            ["type", "config"],
          ),
        ],
      },
    ],
  },
  SourceType: strEnum(["http", "file_tail", "redis_stream", "kafka"]),
  SourceTypeInfo: obj({ type: str(), configSchema: ref("JsonObject") }, ["type", "configSchema"]),
  SourceTypesResponse: obj(
    { sourceTypes: arr(ref("SourceTypeInfo")), parserConfigSchema: ref("JsonObject") },
    ["sourceTypes", "parserConfigSchema"],
  ),
  SourceTestRequest: obj({ parser: ref("ParserConfig"), sample: { ...str("One raw message to parse; at most 8192 bytes (longer is rejected with 400)"), maxLength: 8192 } }, ["parser", "sample"]),
  SourceTestResponse: obj({ parsed: ref("JsonObject") }, ["parsed"]),
  IngestResult: obj({ accepted: { type: "integer", minimum: 0 } }, ["accepted"]),

  // ---- schemas ----
  FieldMapping: {
    oneOf: [
      obj({ kind: { const: "path" }, path: str() }, ["kind", "path"]),
      obj({ kind: { const: "constant" }, value: str() }, ["kind", "value"]),
      obj({ kind: { const: "template" }, template: str() }, ["kind", "template"]),
    ],
    properties: {
      valueMap: { type: "object", additionalProperties: str(), description: "e.g. { ERROR: error }" },
      default: str("Used when the path/template yields nothing"),
    },
  },
  Schema: obj(
    {
      id: str(),
      name: str(),
      match: filter(),
      mapping: {
        type: "object",
        description: `Keys are common field names (${commonFieldNames.join(", ")}) and further names such as sourceStatus, type, message, entity, runbookUrl.`,
        additionalProperties: ref("FieldMapping"),
      },
    },
    ["id", "name", "match", "mapping"],
  ),
  SchemaTestRequest: obj({ schema: ref("Schema"), sample: ref("JsonObject") }, ["schema", "sample"]),
  SchemaTestResponse: obj({ matched: { type: "boolean" }, common: ref("CommonFields") }, ["matched", "common"]),

  // ---- events ----
  Event: obj(
    {
      id: str(),
      sourceId: str(),
      receivedAt: str(),
      raw: { description: "Raw message as received (string for lines, object for JSON)", oneOf: [str(), ref("JsonObject")] },
      parsed: ref("JsonObject"),
      schemaId: optStr(),
      common: ref("CommonFields"),
    },
    ["id", "sourceId", "receivedAt", "raw", "parsed", "common"],
  ),
  TestFilterRequest: obj(
    {
      filter: { description: "Filter text or tree; empty or absent matches everything", oneOf: [str(), ref("FilterNode"), { type: "null" }] },
      limit: { type: "integer", minimum: 1, maximum: 1000, description: "How many recent events to test (default 1000)" },
    },
  ),
  TestFilterResponse: obj({ matched: { type: "integer" }, total: { type: "integer" }, warning: str() }, ["matched", "total"]),
  FilterTextRequest: obj({ text: str() }, ["text"]),
  FilterParseResponse: obj({ tree: ref("FilterNode") }, ["tree"]),
  FilterFormatRequest: obj({ tree: ref("FilterNode") }, ["tree"]),
  FilterFormatResponse: obj({ text: str() }, ["text"]),

  // ---- people ----
  Person: obj(
    {
      id: str(),
      name: str(),
      role: str(),
      canCreateRules: { type: "boolean" },
      ntfyTopic: optStr(),
      starredFilters: arr(ref("StarredFilter")),
    },
    ["id", "name", "role", "canCreateRules"],
  ),
  AccountCreate: obj({ name: str(), role: optStr() }, ["name"]),
  SessionCreate: obj({ personId: str() }, ["personId"]),
  Group: obj({ id: str(), name: str(), memberIds: arr(str()) }, ["id", "name", "memberIds"]),
  RecipientRef: obj({ type: strEnum(["person", "group"]), id: str() }, ["type", "id"]),
  PreferenceRule: obj({ when: ref("FilterNode"), channels: channels() }, ["when", "channels"]),
  QuietHours: obj(
    { from: str("HH:MM"), to: str("HH:MM"), timezone: str(), allowChannels: channels() },
    ["from", "to", "timezone"],
  ),
  Preference: obj(
    {
      ownerType: strEnum(["person", "group"]),
      ownerId: str(),
      rules: arr(ref("PreferenceRule")),
      quietHours: ref("QuietHours"),
    },
    ["ownerType", "ownerId", "rules"],
  ),

  // ---- rules ----
  WhoRow: obj(
    {
      condition: filter(),
      recipients: arr(ref("RecipientRef")),
      force: { ...channels(), description: "Overrides recipients' preferences" },
    },
    ["recipients"],
  ),
  Looks: obj(
    {
      titleTemplate: str(),
      bodyTemplate: str(),
      fields: arr(str()),
      severityOverride: ref("Severity"),
      colour: str(),
    },
    ["titleTemplate", "fields"],
  ),
  Rule: obj(
    {
      id: str(),
      name: str(),
      enabled: { type: "boolean" },
      when: filter(),
      who: arr(ref("WhoRow")),
      looks: ref("Looks"),
      dedupFields: arr(strEnum(commonFieldNames)),
      groupBy: arr(str()),
      groupWindow: { type: "string", pattern: "^\\d+(ms|s|m|h)$", example: "5m", description: "Grouping window; with groupBy, one notification per recipient per burst" },
      createdAt: str(),
      updatedAt: str(),
    },
    ["id", "name", "enabled", "when", "who", "looks"],
  ),

  // ---- runbooks ----
  RunbookStep: {
    oneOf: [
      obj(
        {
          action: { const: "http" },
          name: str(),
          method: str(),
          url: str(),
          headers: { type: "object", additionalProperties: str() },
          body: str("Templated"),
          approval: strEnum(["none", "required"]),
          approvers: str("Group id notified when this step awaits approval"),
        },
        ["action", "method", "url", "approval"],
      ),
      obj(
        {
          action: { const: "escalate" },
          name: str(),
          group: str("Group id"),
          approval: strEnum(["none", "required"]),
          approvers: str("Group id notified when this step awaits approval"),
        },
        ["action", "group", "approval"],
      ),
      obj(
        {
          action: { const: "wait" },
          name: str(),
          duration: str("e.g. 2m, 30s"),
          approval: strEnum(["none", "required"]),
          approvers: str("Group id notified when this step awaits approval"),
        },
        ["action", "duration", "approval"],
      ),
    ],
  },
  Runbook: {
    oneOf: [
      obj(
        { id: str(), name: str(), type: { const: "text" }, matches: filter(), content: str("Markdown with {{field}} placeholders") },
        ["id", "name", "type", "matches", "content"],
      ),
      obj(
        { id: str(), name: str(), type: { const: "automation" }, matches: filter(), steps: arr(ref("RunbookStep")) },
        ["id", "name", "type", "matches", "steps"],
      ),
    ],
  },
  StepRunState: strEnum(["pending", "awaiting_approval", "running", "done", "failed", "skipped"]),
  RunbookRun: obj(
    {
      alertId: str(),
      runbookId: str(),
      runbookName: str(),
      status: strEnum(["running", "awaiting_approval", "done", "failed"]),
      steps: arr(
        obj(
          { index: { type: "integer" }, state: ref("StepRunState"), result: str(), at: str(), name: str() },
          ["index", "state"],
        ),
      ),
    },
    ["alertId", "runbookId", "steps"],
  ),
  ApproveStepRequest: obj({
    actor: str(),
    runbookId: str("Needed when several runbooks await approval at that step"),
    decision: { ...strEnum(["approve", "skip"]), default: "approve" },
  }),
  PendingApproval: obj(
    { alertId: str(), runbookId: str(), stepIndex: { type: "integer" }, stepName: str(), requestedAt: str() },
    ["alertId", "runbookId", "stepIndex", "requestedAt"],
  ),

  // ---- alerts ----
  Alert: obj(
    {
      id: str(),
      ruleId: str(),
      eventId: str(),
      schemaId: optStr(),
      dedupKey: str(),
      state: ref("AlertState"),
      severity: ref("Severity"),
      title: str(),
      body: optStr(),
      source: str(),
      environment: str(),
      count: { type: "integer" },
      firstSeen: str(),
      lastSeen: str(),
      acknowledgedBy: optStr(),
      acknowledgedAt: optStr(),
      resolvedAt: optStr(),
      fields: arr(obj({ label: str(), value: str() }, ["label", "value"])),
      colour: optStr(),
      common: ref("CommonFields"),
    },
    ["id", "ruleId", "eventId", "dedupKey", "state", "severity", "title", "source", "environment", "count", "firstSeen", "lastSeen", "fields"],
  ),
  AlertSummary: obj(
    {
      open: { type: "integer", minimum: 0, description: "Number of open alerts" },
      bySeverity: obj(
        Object.fromEntries(["critical", "error", "warning", "info"].map((k) => [k, { type: "integer", minimum: 0 }])),
        ["critical", "error", "warning", "info"],
        { description: "Open alerts per severity" },
      ),
      byStatus: obj(
        Object.fromEntries(["open", "acknowledged", "resolved"].map((k) => [k, { type: "integer", minimum: 0 }])),
        ["open", "acknowledged", "resolved"],
        { description: "All alerts per state" },
      ),
    },
    ["open", "bySeverity", "byStatus"],
  ),
  AlertDetail: {
    description: "An Alert with its opening event (null when unavailable) and its suggestions.",
    allOf: [
      ref("Alert"),
      obj(
        {
          event: { oneOf: [ref("Event"), { type: "null" }] },
          suggestions: arr(ref("Suggestion")),
          rulebook: { ...arr(ref("RulebookEntry")), description: "The rule's how-to-resolve comments, oldest first" },
        },
        ["event", "suggestions"],
      ),
    ],
  },
  AlertTransitionRequest: obj({
    actor: str("Defaults to the x-actor header, else anonymous"),
    resolution: str("Resolve only: how it was fixed (max 4000 characters)"),
    contribute: { type: "boolean", description: "Resolve only: also add the resolution as a how-to-resolve comment on the rule" },
  }),
  RulebookEntry: obj(
    { id: str(), ruleId: str(), text: str(), updatedBy: str("Author"), updatedAt: str("When it was written"), alertId: str("Alert it was written on") },
    ["id", "ruleId", "text", "updatedBy", "updatedAt"],
  ),
  RulebookCommentRequest: obj({ text: str("1 to 4000 characters"), actor: str("Defaults to the x-actor header, else anonymous") }, ["text"]),
  RuleRunbook: obj(
    { runbook: ref("Runbook"), yaml: str("The runbook as YAML, without the id and matches the server sets") },
    ["runbook", "yaml"],
  ),
  MatchedRunbook: obj(
    {
      id: str(),
      name: str(),
      type: strEnum(["text", "automation"]),
      origin: strEnum(["rule", "config"]),
      content: str("Text runbooks: the instructions with the alert's values filled in"),
      steps: arr(
        obj({ index: { type: "integer" }, name: str(), action: str(), approval: strEnum(["none", "required"]) }, ["index", "name", "action", "approval"]),
      ),
    },
    ["id", "name", "type", "origin"],
  ),
  StartRunbookRequest: obj({ runbookId: str("An automation runbook") }, ["runbookId"]),
  AuditEntry: obj(
    {
      id: str(),
      alertId: str(),
      at: str(),
      actor: str("Person id or system"),
      action: strEnum(["created", "acknowledged", "unacknowledged", "resolved", "step_executed", "step_approved", "step_skipped", "escalated", "suggestion"]),
      runbookId: optStr(),
      stepIndex: { type: ["integer", "null"] },
      result: optStr(),
      detail: optStr(),
    },
    ["id", "alertId", "at", "actor", "action"],
  ),
  Suggestion: obj(
    {
      id: str(),
      ruleId: str(),
      alertId: optStr(),
      author: str(),
      text: str(),
      status: strEnum(["open", "accepted", "dismissed"]),
      createdAt: str(),
    },
    ["id", "ruleId", "author", "text", "status", "createdAt"],
  ),
  SuggestionRequest: obj(
    {
      text: { type: "string", minLength: 1, maxLength: 4000 },
      author: str("Defaults to the x-actor header, else anonymous"),
      alertId: str("Only for /api/rules/{id}/suggestions; must belong to the rule"),
    },
    ["text"],
  ),

  // ---- delivery ----
  Notification: obj(
    {
      id: str(),
      alertId: str(),
      recipientId: str(),
      channel: str(),
      severity: ref("Severity"),
      title: str(),
      body: str(),
      clickUrl: str(),
      runbookUrl: str(),
      digestAlertIds: arr(str()),
      attempt: { type: "integer" },
      createdAt: str(),
      nextAttemptAt: { type: "number", description: "Epoch ms of the next retry" },
    },
    ["id", "alertId", "recipientId", "channel", "severity", "title", "clickUrl", "attempt", "createdAt"],
  ),
  DeadLetter: obj(
    { id: str("Equals notification.id"), notification: ref("Notification"), error: str(), failedAt: str() },
    ["id", "notification", "error", "failedAt"],
  ),
  ChannelStatus: obj(
    { id: str(), healthy: { type: "boolean" }, pending: { type: "integer" }, deadLetters: { type: "integer" }, lastError: str() },
    ["id", "healthy", "pending", "deadLetters"],
  ),

  // ---- system / stream ----
  Health: obj(
    {
      ok: { type: "boolean" },
      checks: obj({ postgres: { type: "boolean" }, redis: { type: "boolean" } }, ["postgres", "redis"]),
    },
    ["ok", "checks"],
  ),
  UiPush: {
    description: "JSON payload of one SSE `data:` line on /api/stream.",
    oneOf: [
      obj({ type: { const: "alert" }, alertId: str(), kind: str() }, ["type", "alertId", "kind"]),
      obj({ type: { const: "event" }, event: ref("Event") }, ["type", "event"]),
      obj({ type: { const: "dead_letter" }, count: { type: "integer" } }, ["type", "count"]),
    ],
  },
};
