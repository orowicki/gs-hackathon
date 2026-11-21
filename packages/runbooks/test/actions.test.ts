import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Alert } from "@alerting/shared";
import { createActionRegistry, createDefaultActions, escalateAction, httpAction, waitAction } from "../src/index.js";
import type { ActionContext } from "../src/index.js";
import { renderTemplate } from "../src/template.js";
import { workflowAlert, workflowEvent } from "./helpers.js";
import { loadDemo, type Demo } from "./demo.js";

const template = { alert: workflowAlert() as Alert, event: workflowEvent() };
const ctx = (): ActionContext => ({
  template,
  render: (s) => renderTemplate(s, template),
  alertId: "a1",
  runbookId: "rb",
  stepIndex: 0,
});

describe("actions", () => {
  let demo: Demo;
  beforeAll(async () => {
    demo = await loadDemo();
  });
  afterAll(() => demo.close());

  it("http renders url/headers/body and reports 2xx", async () => {
    demo.reset();
    const r = await httpAction().execute(
      { action: "http", method: "POST", url: `${demo.url}/workflows/{{workflowId}}/retry`, headers: { "x-id": "{{workflowId}}" }, body: '{"w":"{{workflowId}}"}', approval: "none" },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(r.result).toMatch(/^POST http:\/\/127\.0\.0\.1:\d+\/workflows\/WF-\S+\/retry → 200/);
    expect(demo.calls[0]).toMatchObject({ method: "POST", body: { w: expect.stringMatching(/^WF-/) }, headers: { "x-id": expect.stringMatching(/^WF-/) } });
  });
  it("http non-2xx fails", async () => {
    demo.setHealthy(false);
    const r = await httpAction().execute({ action: "http", method: "GET", url: `${demo.url}/health`, approval: "none" }, ctx());
    demo.setHealthy(true);
    expect(r.ok).toBe(false);
    expect(r.result).toContain("503");
  });
  it("http network error fails and body is truncated", async () => {
    const bad = await httpAction({ timeoutMs: 500 }).execute({ action: "http", method: "GET", url: "http://127.0.0.1:1/x", approval: "none" }, ctx());
    expect(bad.ok).toBe(false);
    const fake = httpAction({ fetch: (async () => new Response("x".repeat(1000), { status: 200 })) as typeof fetch });
    const r = await fake.execute({ action: "http", method: "GET", url: "http://h/", approval: "none" }, ctx());
    expect(r.result.length).toBeLessThan(260);
  });
  it("wait uses sleep and parses units", async () => {
    const slept: number[] = [];
    const w = waitAction({ sleep: async (ms) => void slept.push(ms) });
    for (const d of ["500ms", "30s", "2m", "1h"]) await w.execute({ action: "wait", duration: d, approval: "none" }, ctx());
    expect(slept).toEqual([500, 30_000, 120_000, 3_600_000]);
    expect((await w.execute({ action: "wait", duration: "2m", approval: "none" }, ctx())).result).toBe("waited 2m");
    expect((await w.execute({ action: "wait", duration: "soon", approval: "none" }, ctx())).ok).toBe(false);
  });
  it("escalate calls notifier; fails without or when throwing", async () => {
    const seen: unknown[] = [];
    const e = escalateAction({ notifyGroup: async (g, i) => (seen.push([g, i.alertId, i.stepIndex]), `notified group ${g} (3 people)`) });
    const step = { action: "escalate", group: "counterparty-support", approval: "none" } as const;
    expect(await e.execute(step, ctx())).toEqual({ ok: true, result: "notified group counterparty-support (3 people)" });
    expect(seen).toEqual([["counterparty-support", "a1", 0]]);
    expect((await escalateAction().execute(step, ctx())).ok).toBe(false);
    const boom = escalateAction({ notifyGroup: async () => { throw new Error("down"); } });
    expect(await boom.execute(step, ctx())).toMatchObject({ ok: false });
  });
  it("registry", () => {
    expect(createDefaultActions({}).types().sort()).toEqual(["escalate", "http", "wait"]);
    const r = createActionRegistry();
    r.register({ type: "x", execute: async () => ({ ok: true, result: "" }) });
    expect(r.get("x")?.type).toBe("x");
    expect(r.get("y")).toBeUndefined();
  });
});
