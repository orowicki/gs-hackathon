/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { Alert, AutomationRunbook } from "@alerting/shared";
import { createDefaultActions, createMemoryRunStore, createRunbookRoutes, createRunner, validateRunbook } from "../src/index.js";
import { workflowAlert, workflowEvent } from "./helpers.js";
import { loadDemo, type Demo } from "./demo.js";

describe("runbook http routes", () => {
  let demo: Demo;
  let server: http.Server;
  let base: string;
  let runbook: AutomationRunbook;
  const notified: string[] = [];
  const store = createMemoryRunStore();
  const r = createRunner({
    store,
    actions: createDefaultActions({ notifyGroup: async (g) => (notified.push(g), `notified group ${g} (3 people)`) }),
    retryDelayMs: 0,
  });
  // Alerts the routes know about; a-res is resolved. Unknown ids are 404.
  const alerts = new Map<string, Alert>();
  const routes = createRunbookRoutes({
    runner: r,
    loadAlert: async (id) => alerts.get(id),
    getGroup: async (id) => (id === "settlements-oncall" ? { memberIds: ["p-alice", "bob"] } : undefined),
  });

  beforeAll(async () => {
    demo = await loadDemo();
    // The retry fails twice, so the run stops at the escalation (step 2) waiting for approval.
    demo.setRetryFails(true);
    const text = readFileSync(new URL("../../../config/runbooks/settlement-timeout.yaml", import.meta.url), "utf8").replaceAll(
      "http://demo-service:4100",
      demo.url,
    );
    const v = validateRunbook(parse(text));
    if (!v.ok) throw new Error(v.error);
    runbook = v.runbook as AutomationRunbook;
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      // Stands in for the API's accounts hook (signed-in account).
      const account = req.headers["x-account"] as string | undefined;
      routes.handle(req, res, url, account).then((h) => {
        if (!h) {
          res.writeHead(404);
          res.end();
        }
      });
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.close();
    await demo.close();
  });

  const startRun = (id: string, state: Alert["state"] = "open") => {
    const alert = { ...(workflowAlert() as Alert), id, state };
    alerts.set(id, alert);
    return r.start(runbook, { alert, event: workflowEvent() });
  };
  const get = async (p: string) => {
    const res = await fetch(base + p);
    return { status: res.status, type: res.headers.get("content-type"), json: (await res.json()) as any };
  };
  const post = async (p: string, body?: string, account: string | null = "p-alice") => {
    const res = await fetch(base + p, { method: "POST", body, headers: account ? { "x-account": account } : {} });
    return { status: res.status, json: (await res.json()) as any };
  };

  it("lists runs and approvals, approves as the signed-in member", async () => {
    await startRun("a-1");
    const runs = await get("/api/alerts/a-1/runbook-runs");
    expect(runs.status).toBe(200);
    expect(runs.type).toContain("application/json");
    expect(runs.json).toHaveLength(1);
    expect(runs.json[0].steps.map((s: any) => s.state)).toEqual(["done", "failed", "awaiting_approval"]);
    expect(runs.json[0].steps[0].name).toBeTruthy();
    expect(runs.json[0].template).toBeUndefined();
    expect(runs.json[0].runbook).toBeUndefined();

    const appr = await get("/api/approvals");
    expect(appr.json.map((a: any) => [a.alertId, a.stepIndex])).toContainEqual(["a-1", 2]);
    expect(appr.json.find((a: any) => a.alertId === "a-1").approvers).toBe("settlements-oncall");

    const ok = await post("/api/alerts/a-1/runbook-steps/2/approve");
    expect(ok.status).toBe(200);
    expect(ok.json.status).toBe("done");
    const audit = { json: (await store.listAudit({ alertId: "a-1" })) as any[] };
    expect(audit.json.find((e: any) => e.action === "step_approved").actor).toBe("p-alice");

    const again = await post("/api/alerts/a-1/runbook-steps/2/approve");
    expect(again.status).toBe(409);
    expect(again.json.code).toBe("not_awaiting");
  });

  it("records the signed-in account in the audit log, not a claimed body actor", async () => {
    await startRun("a-2");
    const ok = await post("/api/alerts/a-2/runbook-steps/2/approve", JSON.stringify({ actor: "mallory" }));
    expect(ok.status).toBe(200);
    const audit = { json: (await store.listAudit({ alertId: "a-2" })) as any[] };
    expect(audit.json.filter((e: any) => e.action === "step_executed")).toHaveLength(4); // health, retry attempt 1, retry attempt 2, escalate
    const approved = audit.json.find((e: any) => e.action === "step_approved");
    expect(approved.actor).toBe("p-alice");
    expect(new Date(approved.at).toISOString()).toBe(approved.at);
    expect(await store.listAudit({ alertId: "a-2", limit: 2 })).toHaveLength(2);
    // audit is served by the alerts routes, not the runbooks handler
    expect((await fetch(base + "/api/audit")).status).toBe(404);
    expect((await fetch(base + "/api/alerts/a-2/audit")).status).toBe(404);
  });

  it("supports skip, query params and error codes", async () => {
    await startRun("a-3");
    const skipped = await post("/api/alerts/a-3/runbook-steps/2/approve?actor=mallory", JSON.stringify({ decision: "skip" }), "bob");
    expect(skipped.status).toBe(200);
    expect(skipped.json.steps[2].state).toBe("skipped");
    const audit = { json: (await store.listAudit({ alertId: "a-3" })) as any[] };
    expect(audit.json.find((e: any) => e.action === "step_skipped").actor).toBe("bob");

    expect((await post("/api/alerts/a-3/runbook-steps/x/approve")).status).toBe(400);
    expect((await post("/api/alerts/a-3/runbook-steps/-1/approve")).status).toBe(400);
    expect((await post("/api/alerts/a-3/runbook-steps/2/approve", "{nope")).status).toBe(400);
    const nf = await post("/api/alerts/nope/runbook-steps/2/approve");
    expect(nf.status).toBe(404);
    expect(nf.json.code).toBe("not_found");
    expect((await post("/api/alerts/a-3/runbook-steps/2/approve?runbookId=zzz")).status).toBe(404);
  });

  it("refuses anyone not signed in or outside the approvers group, without touching the step", async () => {
    await startRun("a-4");
    for (const [body, account] of [
      [undefined, null],
      [JSON.stringify({ actor: "p-alice" }), null],
      [JSON.stringify({ decision: "skip" }), null],
    ] as const) {
      const res = await post("/api/alerts/a-4/runbook-steps/2/approve", body, account);
      expect(res.status).toBe(403);
      expect(res.json.code).toBe("forbidden");
    }
    for (const decision of ["approve", "skip"]) {
      const res = await post("/api/alerts/a-4/runbook-steps/2/approve", JSON.stringify({ decision }), "p-carol");
      expect(res.status).toBe(403);
      expect(res.json.code).toBe("forbidden");
    }
    const runs = await get("/api/alerts/a-4/runbook-runs");
    expect(runs.json[0].steps[2].state).toBe("awaiting_approval");
    const audit = await store.listAudit({ alertId: "a-4" });
    expect(audit.some((e) => e.action === "step_approved" || e.action === "step_skipped")).toBe(false);
    // A member still can.
    expect((await post("/api/alerts/a-4/runbook-steps/2/approve", undefined, "bob")).status).toBe(200);
  });

  it("fails closed when the approvers group is unknown", async () => {
    const orphan: AutomationRunbook = {
      ...runbook,
      id: "rb-orphan-group",
      steps: [{ action: "wait", name: "Hold", duration: "0s", approval: "required", approvers: "no-such-group" }],
    };
    const alert = { ...(workflowAlert() as Alert), id: "a-5", state: "open" as const };
    alerts.set("a-5", alert);
    await r.start(orphan, { alert, event: workflowEvent() });
    const res = await post("/api/alerts/a-5/runbook-steps/0/approve", JSON.stringify({ runbookId: orphan.id }));
    expect(res.status).toBe(403);
  });

  it("drops steps of resolved alerts from approvals and refuses to approve them", async () => {
    await startRun("a-6");
    await startRun("a-7");
    alerts.set("a-6", { ...alerts.get("a-6")!, state: "resolved" });
    alerts.delete("a-7"); // gone entirely
    const ids = (await get("/api/approvals")).json.map((a: any) => a.alertId);
    expect(ids).not.toContain("a-6");
    expect(ids).not.toContain("a-7");
    const res = await post("/api/alerts/a-6/runbook-steps/2/approve");
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("alert_resolved");
    expect((await get("/api/alerts/a-6/runbook-runs")).json[0].steps[2].state).toBe("awaiting_approval");
  });
});
