/* eslint-disable @typescript-eslint/no-explicit-any */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Alert, Runbook } from "@alerting/shared";
import { createDefaultActions, createMemoryRunStore, createRunbookRoutes, createRunner } from "../src/index.js";
import { workflowAlert, workflowEvent } from "./helpers.js";

describe("POST /api/alerts/{id}/runbook-runs (run now)", () => {
  const notified: string[] = [];
  const runner = createRunner({
    store: createMemoryRunStore(),
    actions: createDefaultActions({ notifyGroup: async (g) => (notified.push(g), `notified ${g}`) }),
  });
  const runbooks: Record<string, Runbook> = {
    auto: {
      id: "auto",
      name: "Auto",
      type: "automation",
      matches: "",
      steps: [
        { name: "Tell on-call", action: "escalate", group: "oncall", approval: "none" },
        { name: "Tell managers", action: "escalate", group: "managers", approval: "required" },
      ],
    } as unknown as Runbook,
    notes: { id: "notes", name: "Notes", type: "text", matches: "", content: "Do things." } as unknown as Runbook,
  };
  const alert = { ...(workflowAlert() as Alert), id: "a1" };
  const routes = createRunbookRoutes({
    runner,
    registry: { get: (id) => runbooks[id] },
    loadAlert: async (id) => (id === "a1" ? alert : undefined),
    loadEvent: async () => workflowEvent(),
  });
  let server: http.Server;
  let base = "";
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      void routes.handle(req, res, new URL(req.url ?? "/", "http://x")).then((h) => {
        if (!h) res.writeHead(404).end();
      });
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => void server.close());

  const start = (alertId: string, body: unknown) =>
    fetch(`${base}/api/alerts/${alertId}/runbook-runs`, { method: "POST", body: JSON.stringify(body) });

  it("runs until the first approval and returns the run; a second start returns the same run", async () => {
    const r = await start("a1", { runbookId: "auto" });
    expect(r.status).toBe(200);
    const run = (await r.json()) as { status: string; steps: { state: string; name?: string }[] };
    expect(run.steps.map((s) => s.state)).toEqual(["done", "awaiting_approval"]);
    expect(run.steps[1]!.name).toBe("Tell managers");
    expect(notified).toEqual(["oncall"]);
    const again = await start("a1", { runbookId: "auto" });
    expect(((await again.json()) as { steps: { state: string }[] }).steps.map((s) => s.state)).toEqual(["done", "awaiting_approval"]);
    expect(notified).toEqual(["oncall"]);
  });

  it("rejects text runbooks, unknown runbooks and alerts, and bad bodies", async () => {
    expect((await start("a1", { runbookId: "notes" })).status).toBe(400);
    expect((await start("a1", { runbookId: "nope" })).status).toBe(404);
    expect((await start("zz", { runbookId: "auto" })).status).toBe(404);
    expect((await start("a1", {})).status).toBe(400);
  });
});

describe("GET /api/alerts/{id}/runbooks (matching runbooks)", () => {
  it("lists matching runbooks with text filled in and step names, the rule's own first", async () => {
    const alert = { ...(workflowAlert() as Alert), id: "a1" };
    const own = { id: "rule-r", ruleId: alert.ruleId, name: "Own", type: "text", matches: "", content: "Retry {{workflowId}}" } as unknown as Runbook;
    const shared = {
      id: "shared",
      name: "Shared",
      type: "automation",
      matches: "",
      steps: [{ name: "Ping {{workflowId}}", action: "wait", duration: "1s", approval: "required" }],
    } as unknown as Runbook;
    const routes = createRunbookRoutes({
      runner: createRunner({ store: createMemoryRunStore(), actions: createDefaultActions() }),
      registry: { get: () => undefined, match: () => [shared, own] },
      loadAlert: async (id) => (id === "a1" ? alert : undefined),
      loadEvent: async () => workflowEvent(),
    });
    const server = http.createServer((req, res) => void routes.handle(req, res, new URL(req.url ?? "/", "http://x")));
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const list = (await (await fetch(`${base}/api/alerts/a1/runbooks`)).json()) as Array<Record<string, any>>;
      const wf = (workflowEvent().parsed as Record<string, unknown>).workflowId;
      expect(list.map((r) => [r.id, r.origin])).toEqual([["rule-r", "rule"], ["shared", "config"]]);
      expect(list[0]!.content).toBe(`Retry ${wf}`);
      expect(list[1]!.steps).toEqual([{ index: 0, name: `Ping ${wf}`, action: "wait", approval: "required" }]);
      expect((await fetch(`${base}/api/alerts/zz/runbooks`)).status).toBe(404);
    } finally {
      server.close();
    }
  });
});
