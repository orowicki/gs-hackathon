// Pure event generation for the demo (no I/O). Shapes follow Appendix A.
export type Rng = () => number;

export type EventKind = "workflow" | "latency" | "payments" | "trade" | "resolved" | "junk";
export interface DemoEvent {
  kind: EventKind;
  /** One line as sent to a source (JSON text, or junk for "junk"). */
  line: string;
}

const pick = <T>(rng: Rng, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)] as T;
const int = (rng: Rng, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));

// Random-phase steps and names never collide with the showcase's dedup keys (see showcase()), so the
// showcase alerts keep their state for the whole run.
const STEPS = ["reconcile-ledger", "release-collateral", "archive-confirmation", "send-swift-message"];
const ERRORS = [
  { code: "TIMEOUT", message: "Counterparty service did not respond in 5000 ms" },
  { code: "REJECTED", message: "Counterparty rejected the instruction" },
  { code: "SCHEMA", message: "Settlement message failed validation" },
];
const REASONS = ["LIMIT_BREACH", "INVALID_PRICE", "UNKNOWN_COUNTERPARTY", "CREDIT_LIMIT"];
const DESKS = ["rates", "rates", "fx", "credit"];
const PRICING = ["pricing-engine-1", "pricing-engine-2", "pricing-engine-3"];

function metric(
  rng: Rng,
  now: Date,
  service: string,
  alertname: string,
  severity: string,
  summary: string,
  status: "firing" | "resolved",
) {
  return {
    alertname,
    labels: { service, region: pick(rng, ["eu-west", "eu-central"]), severity },
    annotations: { summary },
    startsAt: now.toISOString(),
    status,
  };
}

export function workflowFailed(rng: Rng, now: Date): DemoEvent {
  const prod = rng() < 0.8;
  const err = pick(rng, ERRORS);
  return {
    kind: "workflow",
    line: JSON.stringify({
      type: "WORKFLOW_FAILED",
      workflowId: `WF-${now.toISOString().slice(0, 10).replaceAll("-", "")}-${String(int(rng, 1, 99999)).padStart(5, "0")}`,
      workflowName: pick(rng, ["order-settlement", "order-settlement", "order-settlement", "report-export"]),
      step: pick(rng, STEPS),
      severity: pick(rng, ["ERROR", "ERROR", "WARN", "CRITICAL"]),
      environment: prod ? "prod" : "staging",
      timestamp: now.toISOString(),
      error: err,
    }),
  };
}

export function pricingLatency(rng: Rng, now: Date, status: "firing" | "resolved" = "firing"): DemoEvent {
  const svc = pick(rng, PRICING);
  const ms = int(rng, 250, 1800);
  return {
    kind: status === "resolved" ? "resolved" : "latency",
    line: JSON.stringify(
      metric(rng, now, svc, "HighLatency", pick(rng, ["warning", "warning", "critical"]), `p99 latency ${ms} ms over the last 5 minutes`, status),
    ),
  };
}

export function paymentsCritical(rng: Rng, now: Date, status: "firing" | "resolved" = "firing"): DemoEvent {
  return {
    kind: status === "resolved" ? "resolved" : "payments",
    line: JSON.stringify(
      metric(rng, now, "payments-api", "SlowCheckout", "critical", `Error rate ${int(rng, 5, 40)}% over the last 5 minutes`, status),
    ),
  };
}

export function tradeRejected(rng: Rng, now: Date): DemoEvent {
  const big = rng() < 0.7;
  return {
    kind: "trade",
    line: JSON.stringify({
      meta: { schema: "trade.rejected.v2", producer: "trade-gateway", ts: now.getTime() },
      payload: {
        tradeId: `T-${int(rng, 100000, 999999)}`,
        desk: pick(rng, DESKS),
        notional: big ? int(rng, 10_500_000, 80_000_000) : int(rng, 100_000, 9_000_000),
        currency: pick(rng, ["EUR", "USD", "PLN"]),
        reason: pick(rng, REASONS),
      },
    }),
  };
}

export function unparseable(rng: Rng, now: Date): DemoEvent {
  return {
    kind: "junk",
    line: `${now.toISOString().slice(0, 19).replace("T", " ")} ${pick(rng, PRICING)} !!! cache stampede ??? {unterminated`,
  };
}

/** One event of each Appendix A type (plus a resolved one); used by --once. */
export function oneOfEach(rng: Rng, now: Date): DemoEvent[] {
  return [workflowFailed(rng, now), pricingLatency(rng, now), paymentsCritical(rng, now), tradeRejected(rng, now)];
}

/**
 * Realistic mix: ~25% workflow failures, 25% latency, 20% trades, 10% payments,
 * 8% resolved metrics, 4% junk lines, and 8% repeats of a recent event (dedup).
 */
export function nextEvent(rng: Rng, now: Date, recent: DemoEvent[] = []): DemoEvent {
  const r = rng();
  if (r < 0.08 && recent.length > 0) {
    const prev = pick(rng, recent);
    // Same content again (metrics dedup on alertname + service).
    return prev.kind === "junk" ? unparseable(rng, now) : prev;
  }
  if (r < 0.33) return workflowFailed(rng, now);
  if (r < 0.58) return pricingLatency(rng, now);
  if (r < 0.78) return tradeRejected(rng, now);
  if (r < 0.88) return paymentsCritical(rng, now);
  if (r < 0.96) return rng() < 0.5 ? pricingLatency(rng, now, "resolved") : paymentsCritical(rng, now, "resolved");
  return unparseable(rng, now);
}

export type DemoSink = "http" | "file_tail" | "redis_stream";
export interface ShowcaseStep {
  sink: DemoSink;
  event: DemoEvent;
  /** Pause after sending, ms. */
  gapMs: number;
}

/**
 * Fixed opening sequence of a default run. Enough alone to fill a feed with every severity, five
 * sources, prod and staging, repeats (dedup count > 1) and resolved alerts.
 * Ordering: all events of one dedup key (firing, repeats, resolve) use the SAME sink, so they stay
 * in order; sinks are only mixed across different keys.
 */
export function showcase(now: Date): ShowcaseStep[] {
  const ts = now.toISOString();
  const m = (
    sink: DemoSink,
    service: string,
    alertname: string,
    severity: string,
    summary: string,
    status: "firing" | "resolved",
    environment?: string,
    gapMs = 150,
  ): ShowcaseStep => ({
    sink,
    gapMs,
    event: {
      kind: status === "resolved" ? "resolved" : "latency",
      line: JSON.stringify({
        alertname,
        labels: { service, region: "eu-west", severity, ...(environment ? { environment } : {}) },
        annotations: { summary },
        startsAt: ts,
        status,
      }),
    },
  });
  const wf = (sink: DemoSink, n: string, workflowName: string, step: string, severity: string, environment: string): ShowcaseStep => ({
    sink,
    gapMs: 150,
    event: {
      kind: "workflow",
      line: JSON.stringify({
        type: "WORKFLOW_FAILED",
        workflowId: `WF-SHOWCASE-${n}`,
        workflowName,
        step,
        severity,
        environment,
        timestamp: ts,
        error: { code: "TIMEOUT", message: `${step} did not complete in 5000 ms` },
      }),
    },
  });
  const trade = (sink: DemoSink, tradeId: string, desk: string, notional: number, reason: string): ShowcaseStep => ({
    sink,
    gapMs: 150,
    event: {
      kind: "trade",
      line: JSON.stringify({
        meta: { schema: "trade.rejected.v2", producer: "trade-gateway", ts: now.getTime() },
        payload: { tradeId, desk, notional, currency: "EUR", reason },
      }),
    },
  });
  const pay = "Error rate 27% over the last 5 minutes";
  return [
    // critical, payments-api, prod: fired three times (count 3)
    m("http", "payments-api", "HighErrorRate", "critical", pay, "firing"),
    m("http", "payments-api", "HighErrorRate", "critical", pay, "firing"),
    m("http", "payments-api", "HighErrorRate", "critical", pay, "firing"),
    // critical, payments-api, staging (Anna's rule does not check the environment); resolved at the end
    m("redis_stream", "payments-api", "ConnectionPoolExhausted", "critical", "Connection pool exhausted", "firing", "staging"),
    // pricing-engine-*: warning (resolved later), warning, error, critical (repeated), staging warning
    m("file_tail", "pricing-engine-emea", "HighLatency", "warning", "p99 latency 840 ms over the last 5 minutes", "firing"),
    m("redis_stream", "pricing-engine-emea", "CacheMissRate", "warning", "Cache miss rate 38%", "firing"),
    m("http", "pricing-engine-emea", "QuoteErrors", "error", "Quote error rate 6%", "firing"),
    m("redis_stream", "pricing-engine-apac", "HighLatency", "critical", "p99 latency 1700 ms over the last 5 minutes", "firing"),
    m("redis_stream", "pricing-engine-apac", "HighLatency", "critical", "p99 latency 1700 ms over the last 5 minutes", "firing"),
    m("file_tail", "pricing-engine-staging", "HighLatency", "warning", "p99 latency 610 ms over the last 5 minutes", "firing", "staging"),
    // settlement workflows, prod: error (repeated), error, warning, critical
    wf("http", "1", "order-settlement", "confirm-settlement", "ERROR", "prod"),
    wf("http", "2", "order-settlement", "confirm-settlement", "ERROR", "prod"),
    wf("file_tail", "3", "order-settlement", "validate-counterparty", "ERROR", "prod"),
    wf("file_tail", "4", "order-settlement", "notify-custodian", "WARN", "prod"),
    wf("redis_stream", "5", "order-settlement", "book-trade", "CRITICAL", "prod"),
    // info: big rejected rates trades (Team Rates; trade-rejected maps to severity info)
    trade("http", "T-SHOW-1", "rates", 25_000_000, "LIMIT_BREACH"),
    trade("redis_stream", "T-SHOW-2", "rates", 18_500_000, "CREDIT_LIMIT"),
    // resolves, through the same sink as their firing event, after the firing ones were sent
    m("file_tail", "pricing-engine-emea", "HighLatency", "warning", "p99 latency back to 120 ms", "resolved", undefined, 300),
    m("redis_stream", "payments-api", "ConnectionPoolExhausted", "critical", "Connection pool recovered", "resolved", "staging", 300),
  ];
}
