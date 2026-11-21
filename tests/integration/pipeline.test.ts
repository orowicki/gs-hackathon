import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Alert } from "@alerting/shared";
import { PUBLIC_URL, enabled, startStack, waitFor, type Stack } from "./helpers.ts";

// The three events of docs/human/GIVEN_SPEC.md Appendix A. The step, alertname and tradeId carry
// a per-run suffix so their dedup keys (and alerts) are unique to this run.
const RUN = randomBytes(4).toString("hex");
const STEP = `validate-counterparty-${RUN}`;
const ALERTNAME = `HighErrorRate-${RUN}`;
const TRADE_ID = `T-998877-${RUN}`;
const WORKFLOW = {
  type: "WORKFLOW_FAILED",
  workflowId: "WF-20261023-00042",
  workflowName: "order-settlement",
  step: STEP,
  severity: "ERROR",
  environment: "prod",
  timestamp: "2026-10-23T09:14:02.331Z",
  error: { code: "TIMEOUT", message: "Counterparty service did not respond in 5000 ms" },
};
const METRIC = {
  alertname: ALERTNAME,
  labels: { service: "payments-api", region: "eu-west", severity: "critical" },
  annotations: { summary: "Error rate 12% over the last 5 minutes" },
  startsAt: "2026-10-23T09:13:00Z",
  status: "firing",
};
const TRADE = {
  meta: { schema: "trade.rejected.v2", producer: "trade-gateway", ts: 1792833245000 },
  payload: { tradeId: TRADE_ID, desk: "rates", notional: 25000000, currency: "EUR", reason: "LIMIT_BREACH" },
};

interface Case {
  name: string;
  body: unknown;
  common: Record<string, unknown>;
  ruleId: string;
  dedupKey: string;
  title: string;
  /** recipient -> channels that must have received a notification */
  expect: Record<string, string[]>;
}

const CASES: Case[] = [
  {
    name: "workflow failure",
    body: WORKFLOW,
    common: {
      type: "WORKFLOW_FAILED",
      message: "Counterparty service did not respond in 5000 ms",
      entity: "WF-20261023-00042",
      severity: "error",
    },
    ruleId: "settlements-workflow-failed",
    dedupKey: `order-settlement-${STEP}`,
    title: `Settlement failed at ${STEP}`,
    expect: { marek: ["ntfy", "ui"], julia: ["ntfy", "ui"] },
  },
  {
    name: "metric threshold breach",
    body: METRIC,
    common: {
      type: ALERTNAME,
      message: "Error rate 12% over the last 5 minutes",
      severity: "critical",
      source: "payments-api",
    },
    ruleId: "anna-payments-critical",
    dedupKey: `${ALERTNAME}-payments-api`,
    title: `${ALERTNAME} on payments-api`,
    // Anna's preference sends ntfy only outside quiet hours (20:00-08:00), so only the ui is certain.
    expect: { anna: ["ui"] },
  },
  {
    name: "trade rejected",
    body: TRADE,
    common: {
      type: "trade.rejected.v2",
      message: "LIMIT_BREACH",
      entity: TRADE_ID,
      severity: "info",
    },
    ruleId: "rates-trade-rejected",
    dedupKey: TRADE_ID,
    title: "Rejected EUR 25000000 — LIMIT_BREACH",
    expect: { tomasz: ["ntfy", "ui"], anna: ["ntfy", "ui"] },
  },
];

describe.skipIf(!enabled)("pipeline end to end (Appendix A events)", () => {
  let s: Stack;

  beforeAll(async () => {
    s = await startStack(RUN, CASES.map((c) => c.dedupKey));
  }, 30_000);

  afterAll(async () => {
    await s?.stop();
  }, 30_000);

  async function post(body: unknown): Promise<void> {
    const res = await fetch(s.ingestUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(202);
  }

  async function alertsFor(c: Case): Promise<Alert[]> {
    const r = await s.pool.query<{ data: Alert }>(
      `SELECT a.data FROM alerts a WHERE a.rule_id = $1 AND a.dedup_key = $2
         AND a.data->>'eventId' IN (SELECT id FROM events WHERE source_id = $3)`,
      [c.ruleId, c.dedupKey, s.sourceId],
    );
    return r.rows.map((x) => x.data);
  }

  async function storedEvents(type: string): Promise<Array<{ common: Record<string, unknown>; schema_id: string }>> {
    const r = await s.pool.query<{ common: Record<string, unknown>; schema_id: string }>(
      "SELECT common, schema_id FROM events WHERE source_id = $1 AND common->>'type' = $2",
      [s.sourceId, type],
    );
    return r.rows;
  }

  /** (recipient, channel) pairs delivered for an alert: ui via the push channel, ntfy via the stub server. */
  function delivered(alertId: string): Set<string> {
    const out = new Set<string>();
    for (const n of s.uiNotifications) if (n.alertId === alertId) out.add(`${n.recipientId}:ui`);
    for (const m of s.ntfy.received) {
      if (String(m.click ?? "") === `${PUBLIC_URL}/alerts/${alertId}`)
        out.add(`${String(m.topic).replace(/^alerting-/, "")}:ntfy`);
    }
    return out;
  }

  const wanted = (c: Case): string[] =>
    Object.entries(c.expect).flatMap(([who, chans]) => chans.map((ch) => `${who}:${ch}`));

  describe.each(CASES)("$name", (c) => {
    it("is stored, fires the seeded rule, creates one alert and notifies the recipients", async () => {
      await post(c.body);

      const [ev] = await waitFor("stored event", async () => {
        const rows = await storedEvents(c.common.type as string);
        return rows.length > 0 && rows;
      });
      expect(ev!.common).toMatchObject(c.common);
      expect(ev!.schema_id).toMatch(/^schema-/);

      const alert = await waitFor("alert", async () => {
        const a = await alertsFor(c);
        return a.length > 0 && a[0];
      });
      expect(alert.ruleId).toBe(c.ruleId);
      expect(alert.title).toBe(c.title);
      expect(alert.count).toBe(1);
      expect(alert.severity).toBe(c.common.severity);
      expect(await alertsFor(c)).toHaveLength(1);

      const want = wanted(c);
      await waitFor(`notifications ${want.join(", ")}`, () => want.every((w) => delivered(alert.id).has(w)));
      // Only the recipients of this rule were notified.
      const who = new Set([...delivered(alert.id)].map((d) => d.split(":")[0]));
      expect([...who].sort()).toEqual(Object.keys(c.expect).sort());
    });
  });

  it("each event fired exactly one rule and created exactly one alert", async () => {
    const r = await s.pool.query<{ rule_id: string; n: string }>(
      `SELECT rule_id, count(*) AS n FROM alerts
         WHERE data->>'eventId' IN (SELECT id FROM events WHERE source_id = $1) GROUP BY rule_id`,
      [s.sourceId],
    );
    expect(Object.fromEntries(r.rows.map((x) => [x.rule_id, Number(x.n)]))).toEqual(
      Object.fromEntries(CASES.map((c) => [c.ruleId, 1])),
    );
  });

  it("sending the same events again bumps the count instead of creating a second alert", async () => {
    const before = s.uiNotifications.length;
    const ntfyBefore = s.ntfy.received.length;
    for (const c of CASES) {
      await post(c.body);
      const alert = await waitFor(`bump of ${c.name}`, async () => {
        const a = await alertsFor(c);
        return a[0]?.count === 2 && a[0];
      });
      expect(alert.count).toBe(2);
      expect(await alertsFor(c)).toHaveLength(1);
    }
    // A bump with unchanged severity does not notify again (give a stray notification time to show up).
    await new Promise((r) => setTimeout(r, 300));
    expect(s.ntfy.received.length).toBe(ntfyBefore);
    expect(s.uiNotifications.length).toBe(before);
  });
});
