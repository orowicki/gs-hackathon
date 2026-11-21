import { z, type ZodRawShape } from "zod";
import type { ApiRequest } from "./client.js";

export interface ToolDef {
  name: string;
  description: string;
  shape: ZodRawShape;
  /** Map validated tool input to the HTTP request. */
  request(args: Record<string, unknown>): ApiRequest;
}

const seg = (v: unknown) => encodeURIComponent(String(v));

const id = z.string().min(1).describe("Entity id");
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
  type: z.enum(["http", "file_tail", "redis_stream"]),
  config: z
    .record(z.string(), z.unknown())
    .describe("http: {}. file_tail: { path }. redis_stream: { stream, consumerGroup }"),
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
};

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
      description: `Create a ${kind}.`,
      shape,
      request: (a) => ({ method: "POST", path: base, body: a }),
    },
    {
      name: `update_${kind}`,
      description: `Replace a ${kind} (full object, same id).`,
      shape,
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
  {
    name: "validate_filter",
    description: "Parse and validate a filter expression. Returns the JSON tree, or an error with the position.",
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
      "List alerts. Default order is lastSeen desc, paged with `before` (x-next-before). Another sort/order is paged with `offset`; combining `before` with it is an error.",
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
    }),
  },
  {
    name: "acknowledge_alert",
    description: "Acknowledge an alert. Returns the updated alert.",
    shape: { id },
    request: (a) => ({ method: "POST", path: `/api/alerts/${seg(a.id)}/ack` }),
  },
  {
    name: "resolve_alert",
    description: "Resolve an alert. Returns the updated alert.",
    shape: { id },
    request: (a) => ({ method: "POST", path: `/api/alerts/${seg(a.id)}/resolve` }),
  },
];
