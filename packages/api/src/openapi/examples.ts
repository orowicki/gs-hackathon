/**
 * Request-body examples per operation, taken from the seeded demo data (config/*.yaml, scripts/seed/seed.ts)
 * and GIVEN_SPEC Appendix A. Keyed "METHOD /path" like operationSpecs.
 *
 * Dependencies on other entities (for a fresh database; all other examples are self-contained):
 *  - PUT /api/{sources,schemas,rules,people,groups,runbooks}/{id}: the entity with the example's id must exist
 *    (create it with the matching POST example first; use that id in the path).
 *  - PUT /api/people/{id}/preferences and /starred-filters: person "anna" must exist.
 *  - PUT /api/groups/{id}/preferences: group "rates-desk" must exist.
 *  - POST /ingest/{sourceId}: source "demo-http" must exist, be enabled and be started by the ingest service.
 *  - POST /api/alerts/{id}/ack|resolve|suggestions and .../runbook-steps/{stepIndex}/approve: need a real alert / run.
 */

export interface ExampleSpec {
  summary: string;
  /** JSON value, or the raw text for text media types (application/yaml, application/x-ndjson). */
  value: unknown;
  /** Defaults to application/json. */
  mediaType?: string;
}


const demoHttp = { id: "demo-http", name: "Demo (HTTP)", enabled: true, parser: { type: "json" }, type: "http", config: {} };
const demoLogs = {
  id: "demo-logs",
  name: "Demo (log files)",
  enabled: true,
  parser: { type: "json" },
  type: "file_tail",
  config: { path: "/tmp/demo-logs/*.log" },
};
const demoStream = {
  id: "demo-stream",
  name: "Demo (Redis stream)",
  enabled: true,
  parser: { type: "json" },
  type: "redis_stream",
  config: { stream: "demo:events", consumerGroup: "alerting" },
};

const workflowSchema = {
  id: "schema-workflow-failed",
  name: "Workflow failed",
  match: "type = WORKFLOW_FAILED",
  mapping: {
    severity: { kind: "path", path: "severity", valueMap: { ERROR: "error", WARN: "warning", CRITICAL: "critical" }, default: "error" },
    title: { kind: "template", template: "{{workflowName}} failed at {{step}}" },
    source: { kind: "path", path: "workflowName" },
    environment: { kind: "path", path: "environment" },
    dedupKey: { kind: "template", template: "{{workflowName}}-{{step}}" },
    sourceStatus: { kind: "constant", value: "firing" },
    occurredAt: { kind: "path", path: "timestamp" },
    type: { kind: "path", path: "type" },
    message: { kind: "path", path: "error.message" },
    entity: { kind: "path", path: "workflowId" },
  },
};
const tradeSchema = {
  id: "schema-trade-rejected",
  name: "Trade rejected",
  match: 'meta.schema matches "trade.rejected.*"',
  mapping: {
    severity: { kind: "constant", value: "info" },
    title: { kind: "template", template: "Rejected {{payload.currency}} {{payload.notional}} - {{payload.reason}}" },
    source: { kind: "path", path: "meta.producer" },
    environment: { kind: "constant", value: "prod" },
    dedupKey: { kind: "path", path: "payload.tradeId" },
    occurredAt: { kind: "path", path: "meta.ts" },
  },
};
const metricSchema = {
  id: "schema-metric-breach",
  name: "Metric threshold breach (Prometheus/Alertmanager style)",
  match: "alertname matches * AND labels.service matches * AND startsAt matches *",
  mapping: {
    severity: { kind: "path", path: "labels.severity" },
    title: { kind: "template", template: "{{alertname}} on {{labels.service}}" },
    source: { kind: "path", path: "labels.service" },
    environment: { kind: "path", path: "labels.environment", default: "prod" },
    dedupKey: { kind: "template", template: "{{alertname}}-{{labels.service}}" },
    occurredAt: { kind: "path", path: "startsAt" },
  },
};

const ruleRates = {
  id: "rates-trade-rejected",
  name: "Team Rates",
  enabled: true,
  when: "alert.schema matches trade.rejected.* AND payload.desk = rates AND payload.notional > 10000000",
  who: [{ recipients: [{ type: "group", id: "rates-desk" }], force: ["ntfy", "ui"] }],
  looks: {
    titleTemplate: "Rejected {{payload.currency}} {{payload.notional}} - {{payload.reason}}",
    fields: ["payload.tradeId", "payload.desk", "payload.notional"],
  },
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-01T00:00:00Z",
};
const ruleSettlements = {
  id: "settlements-workflow-failed",
  name: "Team Settlements",
  enabled: true,
  when: "type = WORKFLOW_FAILED AND workflowName = order-settlement AND environment = prod",
  who: [{ recipients: [{ type: "group", id: "settlements-oncall" }], force: ["ntfy", "ui"] }],
  looks: { titleTemplate: "Settlement failed at {{step}}", fields: ["step", "error.message"], colour: "red" },
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-01T00:00:00Z",
};
const ruleAnna = {
  id: "anna-payments-critical",
  name: "Anna (personal)",
  enabled: true,
  when: { type: "and", children: [
    { type: "cmp", field: "alert.severity", op: "=", value: "critical" },
    { type: "cmp", field: "alert.source", op: "=", value: "payments-api" },
  ] },
  who: [{ recipients: [{ type: "person", id: "anna" }] }],
  looks: { titleTemplate: "{{alert.title}}", fields: ["alert.source"] },
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-01T00:00:00Z",
};

const anna = { id: "anna", name: "Anna Kowalska", role: "Payments lead", canCreateRules: true, ntfyTopic: "alerting-anna" };
const ewa = { id: "ewa", name: "Ewa Mazur", role: "Pricing engineer", canCreateRules: false };
const ratesDesk = { id: "rates-desk", name: "Rates desk", memberIds: ["tomasz", "anna"] };
const pricingTeam = { id: "pricing-team", name: "Pricing team", memberIds: ["ewa"] };

const rbText = {
  id: "payments-high-error-rate",
  name: "Payments high error rate",
  type: "text",
  matches: "alertname = HighErrorRate AND labels.service = payments-api",
  content:
    "# {{alertname}} on {{labels.service}}\nRegion: {{labels.region}} - {{annotations.summary}}\n\n1. Open the payments dashboard and check if errors are in one region only.\n2. If one region: fail traffic over to the other region (needs approval from the team lead).\n3. If all regions: check the last deployment and roll it back.\n",
};
const rbAuto = {
  id: "settlement-timeout",
  name: "Settlement workflow timeout",
  type: "automation",
  matches: "type = WORKFLOW_FAILED AND error.code = TIMEOUT",
  steps: [
    { name: "Check counterparty-service health", action: "http", method: "GET", url: "http://demo-service:4100/health", approval: "none" },
    {
      name: "Retry workflow {{workflowId}}",
      action: "http",
      method: "POST",
      url: "http://demo-service:4100/workflows/{{workflowId}}/retry",
      headers: { "content-type": "application/json" },
      body: '{"workflowId":"{{workflowId}}","reason":"{{error.code}}"}',
      approval: "none",
    },
    { name: "Escalate to counterparty-support", action: "escalate", group: "counterparty-support", approval: "required" },
  ],
};

const annaPreference = {
  ownerType: "person",
  ownerId: "anna",
  rules: [{ when: { type: "cmp", field: "alert.severity", op: "=", value: "critical" }, channels: ["ui", "ntfy"] }],
  quietHours: { from: "20:00", to: "08:00", timezone: "Europe/Warsaw", allowChannels: ["ui"] },
};
const groupPreference = {
  ownerType: "group",
  ownerId: "rates-desk",
  rules: [{ when: { type: "cmp", field: "alert.severity", op: ">=", value: "warning" }, channels: ["ui"] }],
};

const workflowEvent = {
  type: "WORKFLOW_FAILED",
  workflowId: "WF-20261023-00042",
  workflowName: "order-settlement",
  step: "validate-counterparty",
  severity: "ERROR",
  environment: "prod",
  timestamp: "2026-10-23T09:14:02.331Z",
  error: { code: "TIMEOUT", message: "Counterparty service did not respond in 5000 ms" },
};
const tradeEvent = {
  meta: { schema: "trade.rejected.v2", producer: "trade-gateway", ts: 1792833245000 },
  payload: { tradeId: "T-998877", desk: "rates", notional: 25000000, currency: "EUR", reason: "LIMIT_BREACH" },
};

const YAML_T = "application/yaml";
const yamlSchema = `id: schema-yaml-demo
name: Workflow failed (YAML import)
match: type = WORKFLOW_FAILED
mapping:
  severity: { kind: path, path: severity, valueMap: { ERROR: error, WARN: warning, CRITICAL: critical }, default: error }
  title: { kind: template, template: "{{workflowName}} failed at {{step}}" }
  source: { kind: path, path: workflowName }
  environment: { kind: path, path: environment }
  dedupKey: { kind: template, template: "{{workflowName}}-{{step}}" }
`;
const yamlSource = `id: demo-http-yaml
name: Demo (HTTP, YAML import)
enabled: true
parser: { type: json }
type: http
config: {}
`;
const yamlRule = `id: yaml-demo-rule
name: Team Settlements (YAML import)
enabled: true
when: 'type = WORKFLOW_FAILED AND workflowName = order-settlement AND environment = prod'
who:
  - recipients:
      - { type: group, id: settlements-oncall }
    force: [ntfy, ui]
looks:
  titleTemplate: 'Settlement failed at {{step}}'
  fields: [step, error.message]
  colour: red
createdAt: '2026-11-01T00:00:00Z'
updatedAt: '2026-11-01T00:00:00Z'
`;

const ex = (summary: string, value: unknown, mediaType?: string): ExampleSpec => ({
  summary,
  value,
  ...(mediaType ? { mediaType } : {}),
});

export const operationExamples: Record<string, Record<string, ExampleSpec>> = {
  "POST /ingest/{sourceId}": {
    workflowFailed: ex("One WORKFLOW_FAILED event (GIVEN_SPEC Appendix A); use sourceId demo-http", workflowEvent),
    tradeRejected: ex("A JSON array with one trade.rejected event", [tradeEvent]),
    ndjson: ex(
      "NDJSON: two events, one per line",
      `${JSON.stringify(workflowEvent)}\n${JSON.stringify({ ...workflowEvent, step: "reserve-funds" })}\n`,
      "application/x-ndjson",
    ),
  },

  "POST /api/sources": {
    http: ex("HTTP ingest source", demoHttp),
    fileTail: ex("File-tail source", demoLogs),
    redisStream: ex("Redis stream source", demoStream),
  },
  "PUT /api/sources/{id}": { http: ex("Rename the HTTP source (path id demo-http)", { ...demoHttp, name: "Demo (HTTP) renamed" }) },
  "POST /api/schemas": {
    workflowFailed: ex("Workflow failed schema", workflowSchema),
    tradeRejected: ex("Trade rejected schema", tradeSchema),
    metricBreach: ex("Prometheus style metric breach", metricSchema),
  },
  "PUT /api/schemas/{id}": { workflowFailed: ex("Rename (path id schema-workflow-failed)", { ...workflowSchema, name: "Workflow failed (v2)" }) },
  "POST /api/rules": {
    ratesTradeRejected: ex("Team Rates (filter as text)", ruleRates),
    settlements: ex("Team Settlements", ruleSettlements),
    annaCritical: ex("Anna personal rule (filter as JSON tree)", ruleAnna),
  },
  "PUT /api/rules/{id}": { rates: ex("Disable Team Rates (path id rates-trade-rejected)", { ...ruleRates, enabled: false }) },
  "POST /api/accounts": { newcomer: ex("A new account", { name: "Piotr Lis", role: "Pricing engineer" }) },
  "POST /api/session": { anna: ex("Sign in as Anna", { personId: "anna" }) },
  "POST /api/people": { anna: ex("Anna", anna), ewa: ex("Ewa", ewa) },
  "PUT /api/people/{id}": { anna: ex("Change Anna's role (path id anna)", { ...anna, role: "Head of payments" }) },
  "POST /api/groups": { ratesDesk: ex("Rates desk", ratesDesk), pricingTeam: ex("Pricing team", pricingTeam) },
  "PUT /api/groups/{id}": { ratesDesk: ex("Add a member (path id rates-desk)", { ...ratesDesk, memberIds: ["tomasz", "anna", "ewa"] }) },
  "POST /api/runbooks": { text: ex("Text runbook", rbText), automation: ex("Automation runbook with an approval gate", rbAuto) },
  "PUT /api/runbooks/{id}": { text: ex("Rename (path id payments-high-error-rate)", { ...rbText, name: "Payments high error rate (v2)" }) },

  "PUT /api/people/{id}/preferences": { anna: ex("Anna: critical also to ntfy, quiet hours 20:00-08:00 (path id anna)", annaPreference) },
  "PUT /api/groups/{id}/preferences": { ratesDesk: ex("Rates desk: warnings and above to ui (path id rates-desk)", groupPreference) },

  "POST /api/schemas/test": {
    workflowFailed: ex("Try the workflow schema on the Appendix A sample", { schema: workflowSchema, sample: workflowEvent }),
  },
  "POST /api/sources/test": {
    json: ex("JSON parser on one line", { parser: { type: "json" }, sample: JSON.stringify(workflowEvent) }),
    logfmt: ex("logfmt parser", { parser: { type: "logfmt" }, sample: 'level=error msg="payment failed" service=payments-api' }),
  },
  "PUT /api/people/{id}/starred-filters": {
    anna: ex("Two starred filters (path id anna)", [
      { id: "critical", name: "Critical only", filter: { type: "cmp", field: "alert.severity", op: "=", value: "critical" } },
      {
        id: "prod-errors",
        name: "Prod errors and above",
        filter: {
          type: "and",
          children: [
            { type: "cmp", field: "alert.environment", op: "=", value: "prod" },
            { type: "cmp", field: "alert.severity", op: ">=", value: "error" },
          ],
        },
      },
    ]),
  },
  "POST /api/events/test-filter": {
    text: ex("Filter as text", { filter: "alert.severity >= error" }),
    tree: ex("Filter as JSON tree", { filter: { type: "cmp", field: "payload.desk", op: "=", value: "rates" }, limit: 100 }),
  },

  "POST /api/filters/parse": { text: ex("Parse a filter", { text: "alert.severity = critical AND alert.source = payments-api" }) },
  "POST /api/filters/format": {
    tree: ex("Render a tree", {
      tree: {
        type: "and",
        children: [
          { type: "cmp", field: "alert.severity", op: "=", value: "critical" },
          { type: "in", field: "alert.environment", values: ["prod", "staging"] },
        ],
      },
    }),
  },

  "POST /api/alerts/{id}/ack": { actor: ex("Acknowledge as Anna", { actor: "anna" }) },
  "POST /api/alerts/{id}/resolve": { actor: ex("Resolve as Marek", { actor: "marek" }) },
  "POST /api/alerts/{id}/runbook-steps/{stepIndex}/approve": {
    approve: ex("Approve the escalation step (step index 2 of settlement-timeout)", {
      actor: "marek",
      runbookId: "settlement-timeout",
      decision: "approve",
    }),
    skip: ex("Skip the step", { actor: "marek", runbookId: "settlement-timeout", decision: "skip" }),
  },
  "POST /api/alerts/{id}/suggestions": {
    text: ex("Suggest tuning the rule", { text: "Only page the on-call after two consecutive timeouts.", author: "julia" }),
  },
  "POST /api/rules/{id}/suggestions": {
    text: ex("Suggest a change to a rule (any rule id; the rule is not checked)", {
      text: "Raise the notional threshold to 20M EUR.",
      author: "tomasz",
    }),
  },

  "POST /api/schemas/import": { yaml: ex("Schema as YAML", yamlSchema, YAML_T) },
  "POST /api/sources/import": { yaml: ex("Source as YAML", yamlSource, YAML_T) },
  "POST /api/rules/import": { yaml: ex("Rule as YAML", yamlRule, YAML_T) },
};
