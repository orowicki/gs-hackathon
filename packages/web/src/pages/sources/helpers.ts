import type { ParserConfig, Source } from "./sourceTypes";
import { sourceTypeLabel } from "./sourceTypes";

/** Intro under "New source": the same on every tab and in the editor. */
export const SOURCE_INTRO = "A source is where events come from: a webhook, log files on disk, a Redis stream or a Kafka topic.";

export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function blankSource(): Source {
  return { id: "", name: "", enabled: true, parser: { type: "json" }, type: "http", config: {} };
}

export interface SourceExample {
  id: string;
  what: string;
  sample: string;
  source: Source;
}

/** Realistic starting points (Appendix A services). */
export const SOURCE_EXAMPLES: SourceExample[] = [
  {
    id: "orders-webhook",
    what: "A service POSTs JSON events to this app.",
    sample: '{"type":"WORKFLOW_FAILED","workflowName":"order-settlement","failedStep":"book-trade","environment":"prod"}',
    source: { id: "orders-webhook", name: "Orders service webhook", enabled: true, type: "http", config: {}, parser: { type: "json" } },
  },
  {
    id: "payments-logs",
    what: "Follow an application's logfmt log files.",
    sample: 'level=error service=payments-api msg="card declined" latency_ms=812',
    source: {
      id: "payments-logs",
      name: "Payments API logs",
      enabled: true,
      type: "file_tail",
      config: { path: "/var/log/payments/*.log" },
      parser: { type: "logfmt" },
    },
  },
  {
    id: "nginx-errors",
    what: "Plain-text log lines, split into fields with a regex.",
    sample: "2026/11/21 06:12:03 [error] upstream timed out while reading response header from pricing-engine-emea",
    source: {
      id: "nginx-errors",
      name: "Nginx error log",
      enabled: true,
      type: "file_tail",
      config: { path: "/var/log/nginx/error.log" },
      parser: { type: "regex", pattern: "^(?<time>\\S+ \\S+) \\[(?<level>\\w+)\\] (?<message>.*)$" },
    },
  },
  {
    id: "payments-kafka",
    what: "Consume payment events from a Kafka topic.",
    sample: '{"type":"PAYMENT_DECLINED","service":"payments-api","amount":1200,"reason":"CARD_EXPIRED"}',
    source: {
      id: "payments-kafka",
      name: "Payment events (Kafka)",
      enabled: true,
      type: "kafka",
      config: { brokers: "redpanda:9092", topic: "payments.events", groupId: "alerting" },
      parser: { type: "json" },
    },
  },
  {
    id: "trades-stream",
    what: "Read trade events from a Redis stream.",
    sample: '{"type":"TRADE_REJECTED","desk":"rates","notional":25000000,"reason":"LIMIT_BREACH"}',
    source: {
      id: "trades-stream",
      name: "Trade events stream",
      enabled: true,
      type: "redis_stream",
      config: { stream: "trades:events", consumerGroup: "alerting" },
      parser: { type: "json" },
    },
  },
];

/** Pasted or uploaded source YAML -> a source to review in the editor before saving. */
export function yamlToSource(text: string, parse: (t: string) => unknown): Source {
  let v: unknown;
  try {
    v = parse(text);
  } catch (e) {
    throw new Error("That isn't valid YAML: " + (e as Error).message.split("\n")[0]);
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Expected one source (a YAML mapping with id, name, type).");
  const r = v as Partial<Source> & Record<string, unknown>;
  if (typeof r.name !== "string" && typeof r.id !== "string") throw new Error("The source needs at least a name or an id.");
  return {
    id: typeof r.id === "string" ? r.id : slugify(String(r.name)),
    name: typeof r.name === "string" ? r.name : String(r.id),
    enabled: r.enabled !== false,
    type: typeof r.type === "string" ? r.type : "http",
    config: r.config && typeof r.config === "object" ? (r.config as Record<string, unknown>) : {},
    parser: r.parser && typeof r.parser === "object" && typeof (r.parser as ParserConfig).type === "string" ? (r.parser as ParserConfig) : { type: "json" },
  };
}

/** The URL services POST to for an http source (served by the app, not under /api). */
export function ingestUrl(id: string): string {
  const origin = typeof window === "undefined" ? "http://localhost:3000" : window.location.origin;
  return `${origin}/ingest/${id ? encodeURIComponent(id) : "<id>"}`;
}

const PARSER_LABEL: Record<string, string> = { json: "JSON", logfmt: "logfmt (key=value)", regex: "a regex", raw: "raw text" };
export const parserLabel = (t: string) => PARSER_LABEL[t] ?? t;

/** One sentence saying what the source does. */
export function sourceSentence(s: Source): string {
  const parse = `parses each message as ${parserLabel(s.parser.type)}`;
  if (s.type === "http") return `Receives events over HTTP at ${ingestUrl(s.id)} and ${parse}.`;
  if (s.type === "file_tail")
    return `Follows ${typeof s.config.path === "string" && s.config.path ? s.config.path : "the files you choose"} and ${parse}, one line at a time.`;
  if (s.type === "redis_stream")
    return `Reads the Redis stream ${typeof s.config.stream === "string" && s.config.stream ? `"${s.config.stream}"` : "you choose"} and ${parse}.`;
  if (s.type === "kafka")
    return `Consumes the Kafka topic ${typeof s.config.topic === "string" && s.config.topic ? `"${s.config.topic}"` : "you choose"}${
      typeof s.config.brokers === "string" && s.config.brokers ? ` on ${s.config.brokers}` : ""
    } and ${parse}.`;
  return `Receives events from a ${sourceTypeLabel(s.type)} source and ${parse}.`;
}

/**
 * In-browser parse, used only while POST /api/sources/test isn't implemented (#133).
 * Mirrors the ingest parsers closely enough for a preview.
 */
export function localParse(parser: ParserConfig, sample: string): Record<string, unknown> {
  const line = sample.trim();
  switch (parser.type) {
    case "json": {
      const v: unknown = JSON.parse(line);
      if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Expected a JSON object.");
      return v as Record<string, unknown>;
    }
    case "logfmt": {
      const out: Record<string, unknown> = {};
      for (const m of line.matchAll(/([\w.-]+)=("(?:[^"\\]|\\.)*"|\S*)/g)) {
        const raw = m[2]!;
        out[m[1]!] = raw.startsWith('"') ? raw.slice(1, -1).replace(/\\"/g, '"') : raw;
      }
      if (Object.keys(out).length === 0) throw new Error("No key=value pairs found.");
      return out;
    }
    case "regex": {
      if (!parser.pattern) throw new Error("Add a pattern with named groups.");
      const m = new RegExp(parser.pattern).exec(line);
      if (!m) throw new Error("The pattern doesn't match this line.");
      if (!m.groups) throw new Error("The pattern has no named groups, e.g. (?<level>\\w+).");
      return { ...m.groups };
    }
    default:
      return { message: line };
  }
}
