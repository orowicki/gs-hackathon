import { classifyEvent, mapCommonFields } from "@alerting/schemas";
import type { CommonFieldName, CommonFields, FieldMapping, Schema } from "./types";

/** Intro under "New schema": the same on every tab and in the editor. */
export const SCHEMA_INTRO =
  "A schema recognises one kind of event and maps its fields onto the alert's common fields (title, severity, source…).";

export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function blankSchema(): Schema {
  return { id: "", name: "", match: "", mapping: {} };
}

export interface SchemaExample {
  id: string;
  what: string;
  sample: string;
  schema: Schema;
}

/** Systems that aren't seeded already, each with a realistic sample event. */
export const SCHEMA_EXAMPLES: SchemaExample[] = [
  {
    id: "datadog-monitor",
    what: "Datadog monitor webhooks: triggered and recovered monitors.",
    sample: JSON.stringify(
      {
        title: "[Triggered] High latency on checkout",
        alert_type: "error",
        priority: "P1",
        host: "checkout-web-12",
        event_type: "triggered",
        date: 1763704800,
        aggregate: "dd-3f9a1c",
        body: "p99 latency above 2s for 5 minutes",
      },
      null,
      2,
    ),
    schema: {
      id: "datadog-monitor",
      name: "Datadog monitor",
      match: "aggregate matches * AND alert_type matches *",
      mapping: {
        title: { kind: "path", path: "title" },
        severity: { kind: "path", path: "alert_type", valueMap: { success: "info" } },
        source: { kind: "path", path: "host" },
        environment: { kind: "constant", value: "prod" },
        dedupKey: { kind: "path", path: "aggregate" },
        sourceStatus: { kind: "path", path: "event_type", valueMap: { triggered: "firing", recovered: "resolved" }, default: "firing" },
        occurredAt: { kind: "path", path: "date" },
        message: { kind: "path", path: "body" },
        type: { kind: "constant", value: "DATADOG_MONITOR" },
      },
    },
  },
  {
    id: "cloudwatch-alarm",
    what: "AWS CloudWatch alarms delivered through SNS.",
    sample: JSON.stringify(
      {
        AlarmName: "payments-api-5xx",
        NewStateValue: "ALARM",
        NewStateReason: "Threshold Crossed: 5xx count above 50 for 2 datapoints",
        StateChangeTime: "2026-11-21T06:00:00Z",
        Region: "eu-west-1",
        Trigger: { Namespace: "AWS/ApplicationELB", MetricName: "HTTPCode_Target_5XX_Count" },
      },
      null,
      2,
    ),
    schema: {
      id: "cloudwatch-alarm",
      name: "AWS CloudWatch alarm",
      match: "AlarmName matches * AND NewStateValue matches *",
      mapping: {
        title: { kind: "template", template: "{{AlarmName}}: {{Trigger.MetricName}}" },
        severity: { kind: "constant", value: "error" },
        source: { kind: "path", path: "AlarmName" },
        environment: { kind: "constant", value: "prod" },
        dedupKey: { kind: "path", path: "AlarmName" },
        sourceStatus: { kind: "path", path: "NewStateValue", valueMap: { ALARM: "firing", OK: "resolved" } },
        occurredAt: { kind: "path", path: "StateChangeTime" },
        message: { kind: "path", path: "NewStateReason" },
        entity: { kind: "path", path: "Trigger.Namespace" },
        type: { kind: "constant", value: "CLOUDWATCH_ALARM" },
      },
    },
  },
  {
    id: "kubernetes-event",
    what: "Kubernetes warning events such as CrashLoopBackOff.",
    sample: JSON.stringify(
      {
        type: "Warning",
        reason: "CrashLoopBackOff",
        message: "Back-off restarting failed container",
        involvedObject: { kind: "Pod", name: "pricing-engine-emea-7d9f", namespace: "pricing" },
        lastTimestamp: "2026-11-21T06:05:00Z",
        count: 7,
      },
      null,
      2,
    ),
    schema: {
      id: "kubernetes-event",
      name: "Kubernetes event",
      match: "involvedObject.kind matches * AND reason matches *",
      mapping: {
        title: { kind: "template", template: "{{reason}}: {{involvedObject.name}}" },
        severity: { kind: "path", path: "type", valueMap: { Warning: "warning", Normal: "info" } },
        source: { kind: "path", path: "involvedObject.namespace" },
        environment: { kind: "constant", value: "prod" },
        dedupKey: { kind: "template", template: "{{involvedObject.name}}-{{reason}}" },
        occurredAt: { kind: "path", path: "lastTimestamp" },
        message: { kind: "path", path: "message" },
        entity: { kind: "path", path: "involvedObject.name" },
        type: { kind: "path", path: "reason" },
      },
    },
  },
];

/** Drop empty value-map keys and empty defaults before saving/testing. */
export function cleanSchema(s: Schema, match: string): Schema {
  const mapping: Schema["mapping"] = {};
  for (const [k, m] of Object.entries(s.mapping) as [CommonFieldName, FieldMapping][]) {
    const out: FieldMapping = { ...m };
    if (out.valueMap) {
      const vm = Object.fromEntries(Object.entries(out.valueMap).filter(([from]) => from !== ""));
      if (Object.keys(vm).length) out.valueMap = vm;
      else delete out.valueMap;
    }
    if (out.default === undefined || out.default === "") delete out.default;
    mapping[k] = out;
  }
  return { ...s, match, mapping };
}

export interface TestResult {
  /** null: no sample to test. */
  matched: boolean | null;
  common: CommonFields;
  /** The match filter doesn't parse. */
  matchError?: string;
}

/**
 * Match and map one sample with the backend's own code (@alerting/schemas), so the
 * editor shows exactly what ingest would produce. Mapping is shown even when the match
 * fails, so you can build the mapping first.
 */
export function testSchema(schema: Schema, match: string, sample: unknown): TestResult {
  if (sample === undefined) return { matched: null, common: {} };
  const s = cleanSchema(schema, match) as unknown as Parameters<typeof mapCommonFields>[1];
  let common: CommonFields = {};
  try {
    common = stringify(mapCommonFields(sample, s));
  } catch {
    common = {};
  }
  let matchError: string | undefined;
  const r = classifyEvent(sample, [s], (e) => {
    matchError = e.message.replace(/^invalid match filter: /, "");
  });
  return { matched: matchError ? false : r.schemaId !== null, common, matchError };
}

function stringify(o: Record<string, unknown>): CommonFields {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null) out[k] = typeof v === "string" ? v : JSON.stringify(v);
  return out as CommonFields;
}

/** Pasted or uploaded schema YAML -> a schema to review in the editor before saving. */
export function yamlToSchema(text: string, parse: (t: string) => unknown): { schema: Schema; match: string } {
  let v: unknown;
  try {
    v = parse(text);
  } catch (e) {
    throw new Error("That isn't valid YAML: " + (e as Error).message.split("\n")[0]);
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Expected one schema (a YAML mapping with id, name, match, mapping).");
  const r = v as Partial<Schema> & Record<string, unknown>;
  if (typeof r.name !== "string" && typeof r.id !== "string") throw new Error("The schema needs at least a name or an id.");
  const schema: Schema = {
    id: typeof r.id === "string" ? r.id : slugify(String(r.name)),
    name: typeof r.name === "string" ? r.name : String(r.id),
    match: r.match ?? "",
    mapping: r.mapping && typeof r.mapping === "object" ? (r.mapping as Schema["mapping"]) : {},
  };
  return { schema, match: typeof schema.match === "string" ? schema.match : "" };
}
