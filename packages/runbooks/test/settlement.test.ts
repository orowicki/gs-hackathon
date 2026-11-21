import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { Alert, AutomationRunbook } from "@alerting/shared";
import { createDefaultActions, createMemoryRunStore, createRunner, matchRunbooks, validateRunbook } from "../src/index.js";
import { workflowAlert, workflowEvent } from "./helpers.js";
import { loadDemo, type Demo } from "./demo.js";

describe("settlement-timeout runbook end to end (SPEC criterion 9)", () => {
  let demo: Demo;
  beforeAll(async () => {
    demo = await loadDemo();
  });
  afterAll(() => demo.close());

  it("runs health + retry, waits for approval, then escalates", async () => {
    const text = readFileSync(new URL("../../../config/runbooks/settlement-timeout.yaml", import.meta.url), "utf8").replaceAll(
      "http://demo-service:4100",
      demo.url,
    );
    const v = validateRunbook(parse(text));
    if (!v.ok) throw new Error(v.error);
    const alert = workflowAlert() as Alert;
    const event = workflowEvent();
    const matched = matchRunbooks([v.runbook], { alert, event });
    expect(matched).toHaveLength(1);

    const notified: string[] = [];
    const runner = createRunner({
      store: createMemoryRunStore(),
      actions: createDefaultActions({ notifyGroup: async (g) => (notified.push(g), `notified group ${g} (3 people)`) }),
    });
    const run = await runner.start(matched[0] as AutomationRunbook, { alert, event });
    expect(run.status).toBe("awaiting_approval");
    expect(demo.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /health", "POST /workflows/WF-20261023-00042/retry"]);
    expect(demo.calls[1]!.body).toEqual({ workflowId: "WF-20261023-00042", reason: "TIMEOUT" });
    expect(notified).toEqual([]);
    expect(await runner.listPendingApprovals()).toHaveLength(1);

    const done = await runner.approve(alert.id, 2, { actor: "p-alice" });
    expect(done.status).toBe("done");
    expect(notified).toEqual(["counterparty-support"]);
    const audit = await runner.listAudit({ alertId: alert.id });
    expect(audit.map((e) => [e.action, e.actor])).toEqual([
      ["step_executed", "system"],
      ["step_executed", "system"],
      ["step_approved", "p-alice"],
      ["step_executed", "p-alice"],
    ]);
    expect(audit.every((e) => !Number.isNaN(Date.parse(e.at)))).toBe(true);
  });
});
