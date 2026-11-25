import { z, type ZodRawShape } from "zod";
import type { ApiRequest } from "./client.js";

export interface ToolDef {
  name: string;
  description: string;
  shape: ZodRawShape;
  /** Pass keys not in `shape` through to the API (get -> edit -> update keeps stored fields). */
  extraKeys?: boolean;
  /** Map validated tool input to the HTTP request. */
  request(args: Record<string, unknown>): ApiRequest;
}

const seg = (v: unknown) => encodeURIComponent(String(v));

const id = z.string().min(1).describe("Entity id");
const actor = z.string().min(1).optional().describe("Who is acting (audit log)");
const filterText = z.string().describe("Filter expression text, e.g. `alert.severity = critical AND alert.source = payments-api`");
const filterNode: z.ZodType<Record<string, unknown>> = z.record(z.string(), z.unknown());
const filterOrTree = z.union([z.string(), filterNode]).describe("Filter as text or as the JSON filter tree");

const parser = z.object({
  type: z.enum(["json", "logfmt", "regex", "raw"]),
  pattern: z.string().optional().describe("For regex: pattern with named groups"),
});

const sourceShape = {
  id: z.string().min(1),
  name: z.string(),
  enabled: z.boolean(),
  parser,
  type: z.enum(["http", "file_tail", "redis_stream", "kafka"]),
  config: z
    .record(z.string(), z.unknown())
    .describe(
      "http: {}. file_tail: { path }. redis_stream: { stream, consumerGroup }. " +
        "kafka: { brokers (comma-separated), topic, groupId, fromBeginning? }",
    ),
};

const fieldMapping = z
  .object({
    kind: z.enum(["path", "constant", "template"]),
    path: z.string().optional().describe("For kind=path"),
    value: z.string().optional().describe("For kind=constant"),
    template: z.string().optional().describe("For kind=template"),
    valueMap: z.record(z.string(), z.string()).optional(),
    default: z.string().optional(),
  })
  .passthrough();

const schemaShape = {
  id: z.string().min(1),
  name: z.string(),
  match: filterOrTree.describe("Which parsed events this schema applies to"),
  mapping: z
    .record(z.string(), fieldMapping)
    .describe("Keys are common fields (severity, title, source, environment, dedupKey, status, occurredAt) or others"),
};

const ruleShape = {
  id: z.string().min(1),
  name: z.string(),
  enabled: z.boolean(),
  when: filterOrTree.describe("Which alerts this rule applies to"),
  who: z
    .array(
      z
        .object({
          condition: filterOrTree.optional(),
          recipients: z.array(z.object({ type: z.enum(["person", "group"]), id: z.string() })),
          force: z.array(z.string()).optional(),
        })
        .passthrough(),
    )
    .describe("Who to notify"),
  looks: z
    .object({
      titleTemplate: z.string(),
      bodyTemplate: z.string().optional(),
      fields: z.array(z.string()),
      severityOverride: z.enum(["info", "warning", "error", "critical"]).optional(),
      colour: z.string().optional(),
    })
    .passthrough(),
  dedupFields: z.array(z.string()).optional(),
  groupBy: z.array(z.string()).optional().describe("Alert fields or dotted event paths to group notifications by. Needs groupWindow."),
  groupWindow: z.string().regex(/^\d+(ms|s|m|h)$/).optional().describe("Length of a grouping window, e.g. 500ms, 30s, 5m, 1h. Needs groupBy."),
};

const approval = z.enum(["none", "required"]).optional().describe('"required" pauses the step until a person approves it in the UI or ntfy. Default "none"');
const stepShape = z
  .object({
    action: z.string().describe('Only "http" (needs method, url), "escalate" (needs group) and "wait" (needs duration) are accepted; any other value is rejected'),
    name: z.string().optional().describe("Human-readable step name"),
    id: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional().describe("Step name usable as steps.<id>.ok in later `if` filters (letters, digits, _). Unique per runbook"),
    if: z.string().optional().describe("Filter checked when the step is reached, e.g. `steps.retry.ok = false`. False = skip the step"),
    retries: z.number().int().min(0).max(5).optional().describe("Re-run a failed step up to N more times (0-5)"),
    approval,
    approvers: z.string().optional().describe("Group id notified with an Approve button when the step awaits approval; default the alert's recipients"),
    method: z.string().optional().describe("http only: HTTP method, e.g. POST"),
    url: z.string().optional().describe("http only: URL, may contain {{field}} placeholders"),
    headers: z.record(z.string(), z.string()).optional().describe("http only: request headers"),
    body: z.string().optional().describe('http only: templated request body string, e.g. {"workflowId":"{{workflowId}}"}'),
    group: z.string().optional().describe("escalate only: id of the group to notify"),
    duration: z.string().regex(/^\d+(ms|s|m|h)$/).optional().describe("wait only: e.g. 30s, 2m, 1h (max 15m)"),
  })
  .passthrough();

const runbookFields = {
  name: z.string().min(1),
  type: z.enum(["text", "automation"]).describe('"text": free-text/markdown instructions shown on the alert, never executed. "automation": executed `steps`'),
  content: z.string().optional().describe("type=text only: markdown/free text with {{field}} placeholders filled from the alert"),
  steps: z.array(stepShape).optional().describe("type=automation only: ordered steps (at least one)"),
};

const runbookShape = {
  id: z.string().min(1),
  ...runbookFields,
  matches: filterOrTree.optional().describe("Which alerts this runbook applies to, e.g. `alert.source = payments-api`. Empty matches nothing useful: set it"),
};

const ruleRunbookShape = {
  id: z.string().min(1).describe("Rule id (the runbook id and matches are set by the server)"),
  ...runbookFields,
  type: runbookFields.type.optional().describe('Default "text"'),
};

const RUNBOOK_NOTE = " set_rule_runbook is the path that validates steps server-side today; for runbooks attached to a rule, prefer it.";

function crud(kind: string, plural: string, base: string, shape: ZodRawShape): ToolDef[] {
  return [
    { name: `list_${plural}`, description: `List all ${plural}.`, shape: {}, request: () => ({ method: "GET", path: base }) },
    {
      name: `get_${kind}`,
      description: `Get one ${kind} by id.`,
      shape: { id },
      request: (a) => ({ method: "GET", path: `${base}/${seg(a.id)}` }),
    },
    {
      name: `create_${kind}`,
      description: `Create a ${kind}. Unknown fields are passed through.${kind === "runbook" ? RUNBOOK_NOTE : ""}`,
      shape,
      extraKeys: true,
      request: (a) => ({ method: "POST", path: base, body: a }),
    },
    {
      name: `update_${kind}`,
      description: `Replace a ${kind} (full object, same id). Unknown fields (e.g. createdAt) are passed through.${kind === "runbook" ? ` This replaces the whole runbook: call get_runbook first and send the full object, including matches.${RUNBOOK_NOTE}` : ""}`,
      shape,
      extraKeys: true,
      request: (a) => ({ method: "PUT", path: `${base}/${seg(a.id)}`, body: a }),
    },
    {
      name: `delete_${kind}`,
      description: `Delete a ${kind} by id.`,
      shape: { id },
      request: (a) => ({ method: "DELETE", path: `${base}/${seg(a.id)}` }),
    },
  ];
}

export const TOOLS: ToolDef[] = [
  ...crud("source", "sources", "/api/sources", sourceShape),
  ...crud("schema", "schemas", "/api/schemas", schemaShape),
  ...crud("rule", "rules", "/api/rules", ruleShape),
  ...crud("runbook", "runbooks", "/api/runbooks", runbookShape),
  {
    name: "get_rule_runbook",
    description: "Get the runbook attached to a rule (error 404 when none). Returns `{ runbook, yaml }`.",
    shape: { id: z.string().min(1).describe("Rule id") },
    request: (a) => ({ method: "GET", path: `/api/rules/${seg(a.id)}/runbook` }),
  },
  {
    name: "set_rule_runbook",
    description:
      "Create or replace the runbook attached to a rule. The runbook id and `matches` are set by the server from the rule id. Returns `{ runbook, yaml }`.",
    shape: ruleRunbookShape,
    extraKeys: true,
    request: (a) => {
      const { id: ruleId, ...body } = a;
      return { method: "PUT", path: `/api/rules/${seg(ruleId)}/runbook`, body };
    },
  },
  {
    name: "validate_filter",
    description: "Parse and validate a filter expression. Returns `{ tree }` (the JSON filter tree), or an error with the position.",
    shape: { text: filterText },
    request: (a) => ({ method: "POST", path: "/api/filters/parse", body: { text: a.text } }),
  },
  {
    name: "list_recent_events",
    description: "List the most recent events, newest first.",
    shape: { limit: z.number().int().min(1).max(1000).optional().describe("Default 50") },
    request: (a) => ({ method: "GET", path: "/api/events/recent", query: { limit: a.limit as number | undefined } }),
  },
  {
    name: "list_alerts",
    description:
      "List alerts. Returns `{ items, nextBefore?, nextOffset? }`: pass nextBefore as `before` (default sort) or nextOffset as `offset` (other sorts) to get the next page. Default order is lastSeen desc, paged with `before` (x-next-before). Another sort/order is paged with `offset`; combining `before` with it is an error.",
    shape: {
      filter: filterText.optional(),
      state: z.enum(["open", "acknowledged", "resolved"]).optional(),
      limit: z.number().int().min(1).max(200).optional().describe("Default 50"),
      before: z.string().optional().describe("Cursor, only with the default sort"),
      sort: z.enum(["lastSeen", "firstSeen", "severity", "count"]).optional(),
      order: z.enum(["asc", "desc"]).optional(),
      offset: z.number().int().min(0).optional().describe("Only with a non-default sort"),
    },
    request: (a) => ({
      method: "GET",
      path: "/api/alerts",
      query: {
        filter: a.filter as string | undefined,
        state: a.state as string | undefined,
        limit: a.limit as number | undefined,
        before: a.before as string | undefined,
        sort: a.sort as string | undefined,
        order: a.order as string | undefined,
        offset: a.offset as number | undefined,
      },
      paging: true,
    }),
  },
  {
    name: "acknowledge_alert",
    description: "Acknowledge an alert. Returns the updated alert. Optional `actor` is recorded in the audit log.",
    shape: { id, actor },
    request: (a) => ({
      method: "POST",
      path: `/api/alerts/${seg(a.id)}/ack`,
      ...(a.actor === undefined ? {} : { body: { actor: a.actor } }),
    }),
  },
  {
    name: "resolve_alert",
    description: "Resolve an alert. Returns the updated alert. Optional `actor` is recorded in the audit log.",
    shape: { id, actor },
    request: (a) => ({
      method: "POST",
      path: `/api/alerts/${seg(a.id)}/resolve`,
      ...(a.actor === undefined ? {} : { body: { actor: a.actor } }),
    }),
  },
];
