import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, expect, it } from "vitest";
import type { Alert } from "@alerting/shared";
import { createDefaultActions, createMemoryRunStore, createRunbookRoutes, createRunner, type RunStore } from "@alerting/runbooks";
import { createServer } from "../src/server.js";
import { createMemoryAlertStores } from "../src/routes/alerts/store.js";

let server: Server | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  if (server) await new Promise((r) => server?.close(r));
  server = undefined;
});

async function setup() {
  const stores = createMemoryAlertStores();
  await stores.alerts.upsert({ id: "a1", state: "open", lastSeen: "2026-10-23T09:10:00.000Z" } as Alert);
  const runStore = createMemoryRunStore();
  // Same wiring as main.ts: runbook audit goes through the alerts audit store.
  const store: RunStore = {
    ...runStore,
    appendAudit: (e) => stores.audit.append(e),
    listAudit: (o) => stores.audit.listByAlert(o?.alertId ?? ""),
  };
  const runner = createRunner({ store, actions: createDefaultActions({ notifyGroup: async () => "ok" }) });
  const runbooks = createRunbookRoutes({ runner });
  let n = 0;
  server = createServer({
    checkPostgres: async () => true,
    checkRedis: async () => true,
    runbooks,
    alerts: { ...stores, events: undefined, publish: () => {}, newId: () => `id${++n}`, now: () => new Date("2026-11-01T12:00:00.000Z") },
  });
  await new Promise<void>((r) => server!.listen(0, r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, stores };
}

it("GET /api/audit and /api/alerts/{id}/audit are served by the alerts routes when runbooks are present", async () => {
  const { url } = await setup();
  expect((await fetch(`${url}/api/alerts/a1/ack`, { method: "POST", headers: { "x-actor": "p-1" }, body: JSON.stringify({ actor: "p-1" }) })).status).toBe(200);
  const all = await fetch(`${url}/api/audit?action=acknowledged&limit=5`);
  expect(all.status).toBe(200);
  const rows = (await all.json()) as Array<{ action: string; alertId: string }>;
  expect(rows.map((r) => r.action)).toEqual(["acknowledged"]);
  const one = await fetch(`${url}/api/alerts/a1/audit`);
  expect(one.status).toBe(200);
  expect(((await one.json()) as Array<{ action: string }>).map((r) => r.action)).toEqual(["acknowledged"]);
});

it("alerts audit returns 404 for an unknown alert even with runbooks present", async () => {
  const { url } = await setup();
  expect((await fetch(`${url}/api/alerts/nope/audit`)).status).toBe(404);
});

it("runbook audit entries appear in the alerts audit log", async () => {
  const { url, stores } = await setup();
  await stores.audit.append({ id: "r1", alertId: "a1", at: "2026-11-01T12:00:00.000Z", actor: "system", action: "step_executed", runbookId: "rb", stepIndex: 0 });
  const rows = (await (await fetch(`${url}/api/alerts/a1/audit`)).json()) as Array<{ action: string }>;
  expect(rows.map((r) => r.action)).toContain("step_executed");
});

it("approvals and runbook-runs routes still reach runbooks", async () => {
  const { url } = await setup();
  const appr = await fetch(`${url}/api/approvals`);
  expect(appr.status).toBe(200);
  expect(await appr.json()).toEqual([]);
  const runs = await fetch(`${url}/api/alerts/a1/runbook-runs`);
  expect(runs.status).toBe(200);
  expect(await runs.json()).toEqual([]);
  const approve = await fetch(`${url}/api/alerts/a1/runbook-steps/0/approve`, { method: "POST", body: "{}" });
  expect(approve.status).toBe(404);
  expect((await approve.json() as { code: string }).code).toBe("not_found");
});
