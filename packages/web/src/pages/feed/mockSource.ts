import type { Alert, AlertState, Person, Severity, StarredFilter } from "@alerting/shared";
import metricBreach from "../../../../../fixtures/alerts/metric-breach.json";
import tradeRejected from "../../../../../fixtures/alerts/trade-rejected.json";
import workflowFailed from "../../../../../fixtures/alerts/workflow-failed.json";
import type { FeedSource, PushMessage } from "./data";
import { sortAlerts } from "./helpers";

export const MOCK_PUSH_INTERVAL_MS = 15_000;
const MIN = 60_000;

export const MOCK_PEOPLE: Person[] = [
  { id: "p-settlements", name: "Priya Raman", role: "Settlements on-call", canCreateRules: true },
  { id: "p-rates", name: "Tomas Weber", role: "Rates desk lead", canCreateRules: true },
  { id: "p-payments", name: "Anna Keller", role: "Payments support (read only)", canCreateRules: false },
];

interface Spec {
  id: string;
  ruleId: string;
  schemaId: string;
  state: AlertState;
  severity: Severity;
  title: string;
  body?: string;
  source: string;
  environment: string;
  dedupKey: string;
  count: number;
  fields: Alert["fields"];
}

/** Builds an alert whose last occurrence was minsAgo minutes ago. */
function build(spec: Spec, minsAgo: number, openedMinsAgo: number, now: number): Alert {
  const lastSeen = new Date(now - minsAgo * MIN).toISOString();
  const firstSeen = new Date(now - openedMinsAgo * MIN).toISOString();
  return {
    ...spec,
    eventId: "evt-" + spec.id,
    firstSeen,
    lastSeen,
    common: {
      severity: spec.severity,
      title: spec.title,
      source: spec.source,
      environment: spec.environment,
      dedupKey: spec.dedupKey,
      status: spec.state === "resolved" ? "resolved" : "firing",
      occurredAt: lastSeen,
    },
  };
}

/** Moves a fixture alert in time so that its last occurrence is minsAgo minutes ago. */
function rebase(raw: unknown, minsAgo: number, now: number): Alert {
  const a = raw as Alert;
  const delta = now - minsAgo * MIN - Date.parse(a.lastSeen);
  const shift = (iso?: string) => (iso ? new Date(Date.parse(iso) + delta).toISOString() : iso);
  return {
    ...a,
    firstSeen: shift(a.firstSeen) as string,
    lastSeen: shift(a.lastSeen) as string,
    acknowledgedAt: shift(a.acknowledgedAt),
    resolvedAt: shift(a.resolvedAt),
    common: { ...a.common, occurredAt: shift(a.common.occurredAt) },
  };
}

const SEED_SPECS: Array<[Spec, number, number]> = [
  [
    {
      id: "alert-wf-00043", ruleId: "rule-settlements", schemaId: "schema-workflow-failed", state: "open", severity: "error",
      title: "order-settlement failed at book-position", body: "Position service rejected the booking: REJECTED",
      source: "order-settlement", environment: "prod", dedupKey: "order-settlement-book-position", count: 2,
      fields: [{ label: "Step", value: "book-position" }, { label: "Error", value: "REJECTED" }],
    },
    6, 21,
  ],
  [
    {
      id: "alert-pricing-0001", ruleId: "rule-pricing-warn", schemaId: "schema-pricing-log", state: "open", severity: "warning",
      title: "pricing-engine-emea: stale curve for EUR/USD", body: "Curve EUR/USD has not updated within its refresh window",
      source: "pricing-engine-emea", environment: "prod", dedupKey: "pricing-engine-emea-EURUSD", count: 4,
      fields: [{ label: "Instrument", value: "EUR/USD" }, { label: "Level", value: "WARN" }],
    },
    11, 48,
  ],
  [
    {
      id: "alert-hier-0002", ruleId: "rule-anna-payments-critical", schemaId: "schema-metric-breach", state: "open", severity: "critical",
      title: "HighErrorRate on payments-api", body: "Error rate 9% over the last 5 minutes",
      source: "payments-api", environment: "staging", dedupKey: "HighErrorRate-payments-api-staging", count: 1,
      fields: [{ label: "Region", value: "us-east" }, { label: "Summary", value: "Error rate 9% over the last 5 minutes" }],
    },
    17, 17,
  ],
  [
    {
      id: "alert-trade-0002", ruleId: "rule-rates-trade-rejected", schemaId: "schema-trade-rejected", state: "open", severity: "warning",
      title: "Rejected GBP 12000000 — LIMIT_BREACH", source: "trade-gateway", environment: "prod",
      dedupKey: "T-998912", count: 1,
      fields: [{ label: "Desk", value: "fx" }, { label: "Trade", value: "T-998912" }],
    },
    26, 26,
  ],
  [
    {
      id: "alert-wf-00044", ruleId: "rule-settlements", schemaId: "schema-workflow-failed", state: "resolved", severity: "error",
      title: "order-settlement failed at validate-counterparty", body: "Counterparty service did not respond in 5000 ms",
      source: "order-settlement", environment: "staging", dedupKey: "order-settlement-validate-counterparty-staging", count: 3,
      fields: [{ label: "Step", value: "validate-counterparty" }, { label: "Error", value: "TIMEOUT" }],
    },
    75, 140,
  ],
];

/** Alerts that arrive while the page is open (new ones, cycling). */
const LIVE_SPECS: Spec[] = [
  {
    id: "", ruleId: "rule-settlements", schemaId: "schema-workflow-failed", state: "open", severity: "error",
    title: "order-settlement failed at validate-counterparty", body: "Counterparty service did not respond in 5000 ms",
    source: "order-settlement", environment: "prod", dedupKey: "", count: 1,
    fields: [{ label: "Step", value: "validate-counterparty" }, { label: "Error", value: "TIMEOUT" }],
  },
  {
    id: "", ruleId: "rule-anna-payments-critical", schemaId: "schema-metric-breach", state: "open", severity: "critical",
    title: "HighErrorRate on payments-api", body: "Error rate 12% over the last 5 minutes",
    source: "payments-api", environment: "prod", dedupKey: "", count: 1,
    fields: [{ label: "Region", value: "eu-west" }, { label: "Summary", value: "Error rate 12% over the last 5 minutes" }],
  },
  {
    id: "", ruleId: "rule-rates-trade-rejected", schemaId: "schema-trade-rejected", state: "open", severity: "info",
    title: "Rejected EUR 25000000 — LIMIT_BREACH", source: "trade-gateway", environment: "prod", dedupKey: "", count: 1,
    fields: [{ label: "Desk", value: "rates" }, { label: "Trade", value: "T-998877" }],
  },
];

export function seedAlerts(now = Date.now()): Alert[] {
  const fixtures = [
    rebase(workflowFailed, 2, now),
    rebase(tradeRejected, 4, now),
    rebase(metricBreach, 9, now),
  ];
  return sortAlerts([...fixtures, ...SEED_SPECS.map(([spec, ago, opened]) => build(spec, ago, opened, now))]);
}

const STARRED_KEY = "alerting.mock.starred.";

function readStarred(personId: string): StarredFilter[] {
  try {
    const raw = localStorage.getItem(STARRED_KEY + personId);
    return raw ? (JSON.parse(raw) as StarredFilter[]) : [];
  } catch {
    return [];
  }
}

/** Fixture-backed source used when the API is missing. Pushes a new or re-occurring alert every 15 s. */
export function createMockSource(intervalMs = MOCK_PUSH_INTERVAL_MS): FeedSource {
  const alerts = new Map<string, Alert>(seedAlerts().map((a) => [a.id, a]));
  let tick = 0;

  /** Odd ticks: an open alert occurs again (count + 1). Even ticks: a new alert. */
  function next(): { alert: Alert; kind: "created" | "updated" } {
    const now = Date.now();
    tick += 1;
    const open = sortAlerts([...alerts.values()]).filter((a) => a.state === "open");
    if (tick % 2 === 1 && open.length > 0) {
      const old = open[(tick >> 1) % open.length]!;
      const again: Alert = {
        ...old,
        count: old.count + 1,
        lastSeen: new Date(now).toISOString(),
        common: { ...old.common, occurredAt: new Date(now).toISOString() },
      };
      alerts.set(again.id, again);
      return { alert: again, kind: "updated" };
    }
    const spec = LIVE_SPECS[(tick >> 1) % LIVE_SPECS.length]!;
    const id = "alert-live-" + tick;
    const fresh = build({ ...spec, id, dedupKey: spec.title + "-" + tick }, 0, 0, now);
    alerts.set(id, fresh);
    return { alert: fresh, kind: "created" };
  }

  return {
    listAlerts: () => Promise.resolve(sortAlerts([...alerts.values()])),
    getAlert(id) {
      const a = alerts.get(id);
      return a ? Promise.resolve(a) : Promise.reject(new Error("No such alert: " + id));
    },
    subscribe(onPush: (p: PushMessage) => void, onStatus) {
      onStatus(true);
      const timer = setInterval(() => {
        const { alert, kind } = next();
        onPush({ type: "alert", alertId: alert.id, kind });
      }, intervalMs);
      return () => clearInterval(timer);
    },
    listPeople: () => Promise.resolve(MOCK_PEOPLE),
    getStarred: (id) => Promise.resolve(readStarred(id)),
    putStarred(id, list) {
      try {
        localStorage.setItem(STARRED_KEY + id, JSON.stringify(list));
      } catch {
        /* storage unavailable: keep going without persistence */
      }
      return Promise.resolve(list);
    },
    suggestFields: () => Promise.resolve([]),
    ack(id) {
      const a = alerts.get(id);
      if (!a) return Promise.reject(new Error("No such alert: " + id));
      if (a.state !== "open") return Promise.reject(new Error("Only open alerts can be acknowledged"));
      const next: Alert = { ...a, state: "acknowledged", acknowledgedAt: new Date().toISOString() };
      alerts.set(id, next);
      return Promise.resolve(next);
    },
    unack(id) {
      const a = alerts.get(id);
      if (!a) return Promise.reject(new Error("No such alert: " + id));
      if (a.state !== "acknowledged") return Promise.reject(new Error("Only acknowledged alerts can be unacknowledged"));
      const next = { ...a, state: "open", acknowledgedAt: undefined, acknowledgedBy: undefined } as Alert;
      alerts.set(id, next);
      return Promise.resolve(next);
    },
  };
}
