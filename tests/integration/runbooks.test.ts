import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { Redis } from "ioredis";
import { parse } from "yaml";
import { migrate } from "@alerting/config";
import { compileRule, createDedupHooks, createPgAlertRepo, createStaticDirectory, processEvent } from "@alerting/engine";
import {
  createDefaultActions,
  createPgRunStore,
  createRunbookRoutes,
  createRunner,
  matchRunbooks,
  migrateRunbooks,
  renderTemplate,
  startRunbookWorker,
  validateRunbook,
} from "@alerting/runbooks";
import { STREAM_ALERTS, type Alert, type AlertEvent, type Event, type Rule, type Runbook } from "@alerting/shared";
import { createServer } from "../../packages/api/src/server.js";
import "../../packages/api/src/routes/runbooks.routes.js"; // Deps augmentation
import "../../packages/api/src/routes/alerts.routes.js"; // Deps augmentation
import { createPgAlertStores, createPgEventLoader } from "../../packages/api/src/routes/alerts/store.js";

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;
const here = new URL("./", import.meta.url);
const repoFile = (p: string) => new URL(`../../${p}`, here);
const fixture = (p: string) => JSON.parse(readFileSync(repoFile(`fixtures/${p}`), "utf8")) as Record<string, unknown>;

const run = randomUUID().slice(0, 8);
const group = `it-runbooks-${run}`;
const wfRuleId = `it-rule-wf-${run}`;
const metricRuleId = `it-rule-metric-${run}`;

const rule = (id: string, when: string): Rule => ({
  id,
  name: id,
  enabled: true,
  when,
  who: [],
  looks: { titleTemplate: "{{title}}", fields: [] },
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
});

function eventOf(name: string, id: string, common: Event["common"]): Event {
  const parsed = fixture(`events/${name}`) as Event["parsed"];
  return { id, sourceId: `it-src-${run}`, receivedAt: "2026-10-23T09:14:02.000Z", raw: parsed, parsed, schemaId: null, common };
}

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe.skipIf(!DATABASE_URL || !REDIS_URL)("Appendix B runbooks end to end (SPEC criterion 9)", () => {
  let pool: pg.Pool;
  let redis: Redis;
  let demo: {
    url: string;
    calls: Array<{ method: string; path: string; body: unknown }>;
    setRetryFails(v: boolean): void;
    close(): Promise<void>;
  };
  let worker: { close(): Promise<void> } | undefined;
  let server: Server | undefined;
  const eventIds: string[] = [];
  const alertIds: string[] = [];
  const streamIds: string[] = [];
  const runbooks: Runbook[] = [];
  const notified: string[] = [];

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    redis = new Redis(REDIS_URL!);
    await migrate(pool);
    await migrateRunbooks(pool);
    // The events table is owned by ingest; create it the same way if the suite runs on a fresh database.
    await pool.query(readFileSync(new URL("../../packages/ingest/migrations/ingest_001_events.sql", here), "utf8"));

    const href = repoFile("fixtures/demo-service/server.mjs").href;
    const mod = (await import(/* @vite-ignore */ href)) as { startDemoService(o: { port: number }): Promise<typeof demo> };
    demo = await mod.startDemoService({ port: 0 });

    const dir = repoFile("config/runbooks/");
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".yaml"))) {
      const text = readFileSync(new URL(f, dir), "utf8").replaceAll("http://demo-service:4100", demo.url);
      const v = validateRunbook(parse(text));
      if (!v.ok) throw new Error(`${f}: ${v.error}`);
      runbooks.push(v.runbook);
    }
  });

  afterAll(async () => {
    await worker?.close();
    if (server) {
      server.closeAllConnections();
      await new Promise((r) => server!.close(r));
    }
    await demo?.close();
    await redis?.xgroup("DESTROY", STREAM_ALERTS, group).catch(() => undefined);
    if (streamIds.length > 0) await redis?.xdel(STREAM_ALERTS, ...streamIds).catch(() => undefined);
    if (pool) {
      await pool.query("DELETE FROM alert_audit WHERE alert_id = ANY($1)", [alertIds]).catch(() => undefined);
      await pool.query("DELETE FROM audit_log WHERE alert_id = ANY($1)", [alertIds]).catch(() => undefined);
      await pool.query("DELETE FROM runbook_runs WHERE alert_id = ANY($1)", [alertIds]).catch(() => undefined);
      await pool.query("DELETE FROM alerts WHERE id = ANY($1)", [alertIds]).catch(() => undefined);
      await pool.query("DELETE FROM events WHERE id = ANY($1)", [eventIds]).catch(() => undefined);
    }
    // dedup state keyed by this run's rule ids
    for (const id of [wfRuleId, metricRuleId]) {
      const keys = await redis?.keys(`*${id}*`).catch(() => [] as string[]);
      if (keys?.length) await redis.del(...keys);
    }
    await pool?.end();
    redis?.disconnect();
  });

  // The consumer group must exist (at "$") before the engine publishes, so only this run's alerts are seen.
  async function raise(event: Event, r: Rule): Promise<Alert> {
    await pool.query(
      "INSERT INTO events (id, source_id, received_at, raw, parsed, schema_id, common) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [event.id, event.sourceId, event.receivedAt, JSON.stringify(event.raw), JSON.stringify(event.parsed), null, JSON.stringify(event.common)],
    );
    eventIds.push(event.id);
    const res = await processEvent(event, {
      rules: [compileRule(r)],
      directory: createStaticDirectory({}),
      enqueue: async () => undefined,
      hooks: createDedupHooks({ redis, repo: createPgAlertRepo(pool) }),
      publishAlert: async (ae: AlertEvent) => {
        streamIds.push((await redis.xadd(STREAM_ALERTS, "*", "data", JSON.stringify(ae))) as string);
      },
      logger: { error: (m: string) => { throw new Error(m); } },
    });
    expect(res.failed).toEqual([]);
    expect(res.alerts).toHaveLength(1);
    alertIds.push(res.alerts[0]!.id);
    return res.alerts[0]!;
  }

  it("text runbook: engine alert matches payments-high-error-rate and renders the event values", async () => {
    const event = eventOf("metric-breach.json", `it-evt-metric-${run}`, { severity: "critical", title: "HighErrorRate" });
    const alert = await raise(event, rule(metricRuleId, "alertname = HighErrorRate"));
    expect((await pool.query("SELECT 1 FROM alerts WHERE id = $1", [alert.id])).rowCount).toBe(1);

    const matched = matchRunbooks(runbooks, { alert, event });
    expect(matched.map((r) => r.id)).toEqual(["payments-high-error-rate"]);
    const rb = matched[0]!;
    expect(rb.type).toBe("text");
    const text = renderTemplate((rb as Runbook & { type: "text" }).content, { alert, event });
    expect(text).toContain("HighErrorRate on payments-api");
    expect(text).toContain("Region: eu-west - Error rate 12% over the last 5 minutes");
  });

  it("automation runbook: worker runs steps, waits for approval, API approve escalates, audit over HTTP", async () => {
    await redis.xgroup("CREATE", STREAM_ALERTS, group, "$", "MKSTREAM").catch((e: unknown) => {
      if (!String(e).includes("BUSYGROUP")) throw e;
    });

    const stores = createPgAlertStores(pool);
    const runStore = createPgRunStore(pool);
    const runner = createRunner({
      store: {
        ...runStore,
        appendAudit: (entry) => stores.audit.append(entry),
        listAudit: async ({ alertId, limit } = {}) => {
          const rows = alertId ? await stores.audit.listByAlert(alertId) : (await stores.audit.list({ limit: limit ?? 100 })).reverse();
          return limit === undefined ? rows : rows.slice(-limit);
        },
      },
      actions: createDefaultActions({ notifyGroup: async (g) => (notified.push(g), `notified group ${g}`) }),
      retryDelayMs: 0,
    });
    const registry = { match: (ctx: { alert: Alert; event?: Event }) => matchRunbooks(runbooks, ctx) };
    const events = createPgEventLoader(pool);
    const errors: unknown[] = [];
    worker = startRunbookWorker({
      redis,
      registry,
      runner,
      group,
      consumer: `it-${run}`,
      onError: (e) => errors.push(e),
      loadAlert: async (id) => (await stores.alerts.get(id)) ?? undefined,
      loadEvent: async (id) => (await events.getEvents([id])).get(id),
    });

    const event = eventOf("workflow-failed.json", `it-evt-wf-${run}`, {
      severity: "error",
      title: "order-settlement failed at validate-counterparty",
      source: "order-settlement",
      environment: "prod",
    });
    // The retry fails twice, so the "if: steps.retry.ok = false" escalation waits for approval.
    demo.setRetryFails(true);
    const alert = await raise(event, rule(wfRuleId, "type = WORKFLOW_FAILED"));

    const pending = await waitFor(async () => {
      const runs = await runner.listRuns(alert.id);
      return runs.find((r) => r.status === "awaiting_approval");
    });
    expect(pending.runbookId).toBe("settlement-timeout");
    expect(errors).toEqual([]);
    expect(demo.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /health",
      "POST /workflows/WF-20261023-00042/retry",
      "POST /workflows/WF-20261023-00042/retry",
    ]);
    expect(demo.calls[1]!.body).toEqual({ workflowId: "WF-20261023-00042", reason: "TIMEOUT" });
    expect(notified).toEqual([]);

    server = createServer({
      checkPostgres: async () => true,
      checkRedis: async () => true,
      runbooks: createRunbookRoutes({ runner, registry: { get: (id) => runbooks.find((r) => r.id === id) } }),
      alerts: { ...stores, events, publish: () => {} },
    });
    await new Promise<void>((r) => server!.listen(0, r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const approvals = (await (await fetch(`${base}/api/approvals`)).json()) as Array<{ alertId: string; stepIndex: number }>;
    expect(approvals.filter((a) => a.alertId === alert.id).map((a) => a.stepIndex)).toEqual([2]);

    const res = await fetch(`${base}/api/alerts/${alert.id}/runbook-steps/2/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor: "p-alice" }),
    });
    expect(res.status).toBe(200);
    expect((await runner.listRuns(alert.id))[0]!.status).toBe("done");
    expect(notified).toEqual(["counterparty-support"]);

    const auditRes = await fetch(`${base}/api/alerts/${alert.id}/audit`);
    expect(auditRes.status).toBe(200);
    const audit = (await auditRes.json()) as Array<{ action: string; actor: string; at: string; stepIndex?: number; result?: string }>;
    expect(audit.map((e) => [e.action, e.actor, e.stepIndex])).toEqual([
      ["step_executed", "system", 0],
      ["step_executed", "system", 1],
      ["step_executed", "system", 1],
      ["step_approved", "p-alice", 2],
      ["step_executed", "p-alice", 2],
    ]);
    const times = audit.map((e) => Date.parse(e.at));
    expect(times.every((t) => !Number.isNaN(t))).toBe(true);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    const retry500 = `POST ${demo.url}/workflows/WF-20261023-00042/retry \u2192 500 {"workflowId":"WF-20261023-00042","status":"failed","error":"counterparty timed out again"}`;
    expect(audit.map((e) => e.result)).toEqual([
      `GET ${demo.url}/health \u2192 200 {"status":"ok"}`,
      `attempt 1 of 2 failed: ${retry500}`,
      `failed 2 of 2 attempts: ${retry500}`,
      undefined,
      "notified group counterparty-support",
    ]);
  });
});
