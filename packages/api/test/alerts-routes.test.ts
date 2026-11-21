import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import pg from "pg";
import type { Alert, AuditEntry, Event, Suggestion, UiPush } from "@alerting/shared";
import { createServer, type Deps } from "../src/server.js";
import { createMemoryAlertStores, createPgAlertStores, memoryEventLoader } from "../src/routes/alerts/store.js";
import type { AlertsApiDeps } from "../src/routes/common.js";

const root = new URL("../../../", import.meta.url);
const fx = <T>(p: string): T => JSON.parse(readFileSync(new URL(p, root), "utf8")) as T;
const base: Deps = { checkPostgres: async () => true, checkRedis: async () => true };

let server: Server | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  if (server) await new Promise((r) => server?.close(r));
  server = undefined;
});

const names = ["metric-breach", "trade-rejected", "workflow-failed"];
// fixtures/events/*.json hold the raw payloads; wrap them into stored Events.
const events: Event[] = names.map((n) => {
  const payload = fx<Record<string, unknown>>(`fixtures/events/${n}.json`);
  return { id: n, sourceId: "src", receivedAt: "2026-10-23T09:13:00.000Z", raw: payload, parsed: payload, schemaId: null, common: {} } as Event;
});

async function setup(opts: { withEvents?: boolean } = {}) {
  const stores = createMemoryAlertStores();
  const pushes: UiPush[] = [];
  let n = 0;
  const alerts: Alert[] = names.map((nm, i) => {
    const a = fx<Alert>(`fixtures/alerts/${nm}.json`);
    return { ...a, id: `a${i}`, state: "open", lastSeen: `2026-10-23T09:1${i}:00.000Z`, acknowledgedBy: undefined, acknowledgedAt: undefined, resolvedAt: undefined };
  });
  alerts[2]!.severity = "warning";
  alerts[0]!.severity = "critical";
  alerts[1]!.severity = "error";
  for (const a of alerts) await stores.alerts.upsert(a);
  events.forEach((e, i) => stores.events.set(alerts[i]!.eventId, { ...e, id: alerts[i]!.eventId }));
  const api: AlertsApiDeps = {
    alerts: stores.alerts,
    audit: stores.audit,
    suggestions: stores.suggestions,
    events: opts.withEvents === false ? undefined : memoryEventLoader(stores.events),
    publish: (p) => pushes.push(p),
    now: () => new Date("2026-11-01T12:00:00.000Z"),
    newId: () => `id${++n}`,
  };
  server = createServer({ ...base, alerts: api });
  await new Promise<void>((r) => server!.listen(0, r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, pushes, alerts, stores };
}
const post = (url: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body), headers });
const ids = (xs: Array<{ id: string }>) => xs.map((x) => x.id);

describe("alerts list", () => {
  it("is newest first and paginates via x-next-before", async () => {
    const { url } = await setup();
    const r1 = await fetch(`${url}/api/alerts?limit=2`);
    expect(ids((await r1.json()) as Alert[])).toEqual(["a2", "a1"]);
    const next = r1.headers.get("x-next-before")!;
    expect(next).toBeTruthy();
    const r2 = await fetch(`${url}/api/alerts?limit=2&before=${next}`);
    expect(ids((await r2.json()) as Alert[])).toEqual(["a0"]);
    expect(r2.headers.get("x-next-before")).toBeNull();
    expect((await fetch(`${url}/api/alerts?before=garbage`)).status).toBe(400);
  });

  it("filters by text, tree and raw event path", async () => {
    const { url } = await setup();
    const q = async (qs: string) => ids((await (await fetch(`${url}/api/alerts?${qs}`)).json()) as Alert[]);
    expect(await q("filter=" + encodeURIComponent("alert.severity >= error"))).toEqual(["a1", "a0"]);
    expect(await q("filter=" + encodeURIComponent("alert.status = open AND alert.severity = warning"))).toEqual(["a2"]);
    const tree = { type: "cmp", field: "alert.severity", op: "=", value: "critical" };
    expect(await q("tree=" + encodeURIComponent(JSON.stringify(tree)))).toEqual(["a0"]);
    expect(await q("filter=" + encodeURIComponent("alertname = HighErrorRate"))).toEqual(["a0"]);
    expect(await q("state=resolved")).toEqual([]);
  });

  it("rejects bad filters and trees with 400", async () => {
    const { url } = await setup();
    const bad = await fetch(`${url}/api/alerts?filter=${encodeURIComponent("alert.severity >=")}`);
    expect(bad.status).toBe(400);
    const body = (await bad.json()) as { error: string; position: number };
    expect(body.error).toBeTruthy();
    expect(typeof body.position).toBe("number");
    expect((await fetch(`${url}/api/alerts?tree=${encodeURIComponent('{"type":"nope"}')}`)).status).toBe(400);
    expect((await fetch(`${url}/api/alerts?tree=%7B`)).status).toBe(400);
  });
});

describe("alert detail", () => {
  it("embeds event and suggestions; 404 when missing", async () => {
    const { url, alerts } = await setup();
    const d = (await (await fetch(`${url}/api/alerts/a0`)).json()) as Alert & { event: Event; suggestions: Suggestion[] };
    expect(d.id).toBe("a0");
    expect(d.event.parsed).toEqual(events[0]!.parsed);
    expect(d.suggestions).toEqual([]);
    expect(alerts.length).toBe(3);
    expect((await fetch(`${url}/api/alerts/nope`)).status).toBe(404);
    expect((await fetch(`${url}/api/alerts/nope/audit`)).status).toBe(404);
  });

  it("event is null without a loader", async () => {
    const { url } = await setup({ withEvents: false });
    const d = (await (await fetch(`${url}/api/alerts/a0`)).json()) as { event: unknown };
    expect(d.event).toBeNull();
  });
});

describe("ack and resolve", () => {
  it("acks with actor, audits, publishes; second ack 409", async () => {
    const { url, pushes } = await setup();
    const r = await post(`${url}/api/alerts/a0/ack`, { actor: "  anna " });
    expect(r.status).toBe(200);
    const a = (await r.json()) as Alert;
    expect(a).toMatchObject({ state: "acknowledged", acknowledgedBy: "anna", acknowledgedAt: "2026-11-01T12:00:00.000Z" });
    const audit = (await (await fetch(`${url}/api/alerts/a0/audit`)).json()) as AuditEntry[];
    expect(audit).toEqual([{ id: "id1", alertId: "a0", at: "2026-11-01T12:00:00.000Z", actor: "anna", action: "acknowledged" }]);
    expect(pushes).toEqual([{ type: "alert", alertId: "a0", kind: "acknowledged" }]);
    const again = await post(`${url}/api/alerts/a0/ack`);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ state: "acknowledged" });
    expect(pushes.length).toBe(1);
  });

  it("uses x-actor header and anonymous fallback", async () => {
    const { url } = await setup();
    await post(`${url}/api/alerts/a0/ack`, undefined, { "x-actor": "bob" });
    await post(`${url}/api/alerts/a1/ack`);
    const all = (await (await fetch(`${url}/api/audit`)).json()) as AuditEntry[];
    expect(all.map((e) => e.actor).sort()).toEqual(["anonymous", "bob"]);
  });

  it("resolves from acknowledged, twice 409, ack after resolve 409", async () => {
    const { url, pushes } = await setup();
    await post(`${url}/api/alerts/a0/ack`, {});
    const r = await post(`${url}/api/alerts/a0/resolve`, {});
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ state: "resolved", resolvedAt: "2026-11-01T12:00:00.000Z" });
    expect((await post(`${url}/api/alerts/a0/resolve`)).status).toBe(409);
    expect((await post(`${url}/api/alerts/a0/ack`)).status).toBe(409);
    expect(pushes.map((p) => (p as { kind: string }).kind)).toEqual(["acknowledged", "resolved"]);
    expect((await post(`${url}/api/alerts/a1/resolve`)).status).toBe(200);
  });

  it("404s and bad bodies", async () => {
    const { url } = await setup();
    expect((await post(`${url}/api/alerts/nope/ack`)).status).toBe(404);
    expect((await post(`${url}/api/alerts/nope/resolve`)).status).toBe(404);
    expect((await post(`${url}/api/alerts/a0/ack`, "{")).status).toBe(400);
    expect((await fetch(`${url}/api/alerts/x/y`)).status).toBe(404);
    expect((await fetch(`${url}/api/alerts/a0/ack`)).status).toBe(404);
  });
});

describe("suggestions", () => {
  it("creates, lists, accepts, dismisses, conflicts", async () => {
    const { url } = await setup();
    const c = await post(`${url}/api/rules/r1/suggestions`, { text: "  lower threshold ", author: "eve" });
    expect(c.status).toBe(201);
    const s = (await c.json()) as Suggestion;
    expect(s).toMatchObject({ ruleId: "r1", text: "lower threshold", author: "eve", status: "open" });
    expect((await post(`${url}/api/rules/r1/suggestions`, { text: "second" })).status).toBe(201);
    const list = (await (await fetch(`${url}/api/rules/r1/suggestions`)).json()) as Suggestion[];
    expect(list.length).toBe(2);
    const acc = await post(`${url}/api/suggestions/${s.id}/accept`);
    expect(acc.status).toBe(200);
    expect(await acc.json()).toMatchObject({ status: "accepted" });
    expect((await post(`${url}/api/suggestions/${s.id}/dismiss`)).status).toBe(409);
    const open = (await (await fetch(`${url}/api/rules/r1/suggestions?status=open`)).json()) as Suggestion[];
    expect(open.length).toBe(1);
    const dis = await post(`${url}/api/suggestions/${open[0]!.id}/dismiss`);
    expect(await dis.json()).toMatchObject({ status: "dismissed" });
    expect((await post(`${url}/api/suggestions/nope/accept`)).status).toBe(404);
  });

  it("validates text", async () => {
    const { url } = await setup();
    expect((await post(`${url}/api/rules/r1/suggestions`, {})).status).toBe(400);
    expect((await post(`${url}/api/rules/r1/suggestions`, { text: "   " })).status).toBe(400);
    expect((await post(`${url}/api/rules/r1/suggestions`, { text: "x".repeat(4001) })).status).toBe(400);
    expect((await post(`${url}/api/rules/r1/suggestions`, { text: "x".repeat(4000) })).status).toBe(201);
  });

  it("alert suggestion attaches the rule id and writes an audit entry", async () => {
    const { url, alerts } = await setup();
    const r = await post(`${url}/api/alerts/a0/suggestions`, { text: "tune it" }, { "x-actor": "carol" });
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ ruleId: alerts[0]!.ruleId, alertId: "a0", author: "carol" });
    const audit = (await (await fetch(`${url}/api/alerts/a0/audit`)).json()) as AuditEntry[];
    expect(audit.map((e) => e.action)).toEqual(["suggestion"]);
    const d = (await (await fetch(`${url}/api/alerts/a0`)).json()) as { suggestions: Suggestion[] };
    expect(d.suggestions.length).toBe(1);
    expect((await post(`${url}/api/alerts/nope/suggestions`, { text: "x" })).status).toBe(404);
  });
});

describe("routing fallthrough", () => {
  it("unclaimed alerts paths 404 via the final handler", async () => {
    const { url } = await setup();
    const r = await fetch(`${url}/api/alerts/x/runbook-runs`, { method: "POST" });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "not found" });
    expect((await fetch(`${url}/api/alertsfoo`)).status).toBe(404);
    expect((await fetch(`${url}/api/approvals`)).status).toBe(404);
  });

  it("handleAlertsRoutes / handleSuggestionsRoutes decline unknown paths so a later handler can claim them", async () => {
    const { handleAlertsRoutes } = await import("../src/routes/alerts/http.js");
    const { handleSuggestionsRoutes } = await import("../src/routes/suggestions/http.js");
    const stores = createMemoryAlertStores();
    const deps: AlertsApiDeps = { alerts: stores.alerts, audit: stores.audit, suggestions: stores.suggestions };
    const path = "/api/alerts/x/runbook-runs";
    const req = { method: "POST" } as never;
    const res = {} as never;
    const u = new URL(`http://x${path}`);
    expect(await handleAlertsRoutes(req, res, path, u, deps)).toBe(false);
    expect(await handleSuggestionsRoutes(req, res, path, u, deps)).toBe(false);
  });
});

describe("robustness", () => {
  it("413 on oversize body with connection close", async () => {
    const { url } = await setup();
    const r = await post(`${url}/api/alerts/a0/ack`, { actor: "x".repeat(70 * 1024) });
    expect(r.status).toBe(413);
    expect(r.headers.get("connection")).toBe("close");
  });

  it("a failing publish does not fail the ack, and the audit row exists", async () => {
    const { url, stores } = await setup();
    // rebuild a server whose publish throws
    await new Promise((r) => server?.close(r));
    server = createServer({
      ...base,
      alerts: {
        alerts: stores.alerts,
        audit: stores.audit,
        suggestions: stores.suggestions,
        publish: () => {
          throw new Error("boom");
        },
        newId: () => "audit-1",
      },
    });
    await new Promise<void>((r) => server!.listen(0, r));
    const u2 = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    void url;
    expect((await post(`${u2}/api/alerts/a0/ack`, {})).status).toBe(200);
    expect((await stores.audit.listByAlert("a0")).map((e) => e.id)).toEqual(["audit-1"]);
  });

  it("rule suggestion with alertId must match the alert's rule", async () => {
    const { url, alerts } = await setup();
    const bad = await post(`${url}/api/rules/other-rule/suggestions`, { text: "x", alertId: "a0" });
    expect(bad.status).toBe(400);
    expect((await post(`${url}/api/rules/${alerts[0]!.ruleId}/suggestions`, { text: "x", alertId: "nope" })).status).toBe(400);
    const ok = await post(`${url}/api/rules/${alerts[0]!.ruleId}/suggestions`, { text: "x", alertId: "a0" });
    expect(ok.status).toBe(201);
  });
});

describe("audit paging", () => {
  it("pages with equal timestamps via opaque cursor, and accepts a plain ISO before", async () => {
    const { url, stores } = await setup();
    const at = "2026-11-02T00:00:00.000Z";
    for (const id of ["e1", "e2", "e3", "e4", "e5"])
      await stores.audit.append({ id, alertId: "a0", at, actor: "x", action: "acknowledged" });
    const seen: string[] = [];
    let before = "";
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`${url}/api/audit?limit=2${before ? `&before=${before}` : ""}`);
      seen.push(...((await r.json()) as AuditEntry[]).map((e) => e.id));
      const next = r.headers.get("x-next-before");
      if (!next) break;
      before = next;
    }
    expect(seen).toEqual(["e5", "e4", "e3", "e2", "e1"]);
    const older = (await (await fetch(`${url}/api/audit?before=${at}`)).json()) as AuditEntry[];
    expect(older).toEqual([]);
    const newer = (await (await fetch(`${url}/api/audit?before=2026-11-03T00:00:00.000Z`)).json()) as AuditEntry[];
    expect(newer.length).toBe(5);
  });
});

describe("audit listing", () => {
  it("filters by alertId, actor, action, before, limit", async () => {
    const { url } = await setup();
    await post(`${url}/api/alerts/a0/ack`, { actor: "anna" });
    await post(`${url}/api/alerts/a0/resolve`, { actor: "bob" });
    await post(`${url}/api/alerts/a1/ack`, { actor: "anna" });
    const q = async (qs: string) => (await (await fetch(`${url}/api/audit?${qs}`)).json()) as AuditEntry[];
    expect((await q("")).length).toBe(3);
    expect((await q("alertId=a0")).length).toBe(2);
    expect((await q("actor=anna")).length).toBe(2);
    expect((await q("action=resolved")).map((e) => e.actor)).toEqual(["bob"]);
    expect((await q("limit=1")).length).toBe(1);
    expect((await q("before=2026-11-01T12:00:00.000Z")).length).toBe(0);
    expect((await fetch(`${url}/api/audit?before=zzz`)).status).toBe(400);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("pg stores", () => {
  it("lists, transitions and audits", async () => {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const prefix = `t29-${Date.now()}-`;
    try {
      const s = createPgAlertStores(pool);
      const mk = (i: number): Alert => ({
        ...fx<Alert>("fixtures/alerts/metric-breach.json"),
        id: `${prefix}${i}`,
        state: "open",
        lastSeen: `2026-10-23T09:1${i}:00.000Z`,
      });
      for (const i of [0, 1, 2]) await s.alerts.upsert(mk(i));
      const page = await s.alerts.list({ limit: 1000 });
      const mine = page.filter((a) => a.id.startsWith(prefix));
      expect(ids(mine)).toEqual([`${prefix}2`, `${prefix}1`, `${prefix}0`]);
      const older = await s.alerts.list({ before: { lastSeen: mk(2).lastSeen, id: mk(2).id }, limit: 1000 });
      expect(ids(older.filter((a) => a.id.startsWith(prefix)))).toEqual([`${prefix}1`, `${prefix}0`]);
      const t = await s.alerts.transition(`${prefix}0`, ["open"], { state: "acknowledged", acknowledgedBy: "x" });
      expect(t).toMatchObject({ state: "acknowledged" });
      expect(await s.alerts.transition(`${prefix}0`, ["open"], { state: "acknowledged" })).toBe("conflict");
      expect(await s.alerts.transition(`${prefix}none`, ["open"], {})).toBeNull();
      await s.audit.append({ id: `${prefix}e1`, alertId: `${prefix}0`, at: "2026-11-01T00:00:00.000Z", actor: "x", action: "acknowledged" });
      expect((await s.audit.listByAlert(`${prefix}0`)).length).toBe(1);
      expect((await s.audit.list({ alertId: `${prefix}0`, limit: 10 })).length).toBe(1);
    } finally {
      await pool.query("DELETE FROM alerts WHERE id LIKE $1", [`${prefix}%`]);
      await pool.query("DELETE FROM alert_audit WHERE id LIKE $1", [`${prefix}%`]);
      await pool.end();
    }
  });
});
