import { describe, expect, it } from "vitest";
import type { Alert, AutomationRunbook } from "@alerting/shared";
import { createActionRegistry, createMemoryRunStore, createRunner, RunnerError } from "../src/index.js";
import type { ActionPlugin } from "../src/index.js";
import { workflowAlert } from "./helpers.js";

const plugin: ActionPlugin = { type: "t", execute: async () => ({ ok: true, result: "ok" }) };
const groups: Record<string, string[]> = { oncall: ["marek", "julia"] };
const runner = () =>
  createRunner({
    store: createMemoryRunStore(),
    actions: createActionRegistry([plugin]),
    mayApprove: (actor, g) => !groups[g] || groups[g]!.includes(actor),
  });
const step = (name: string, approvers?: string) =>
  ({ action: "t", name, approval: "required", approvers }) as unknown as AutomationRunbook["steps"][number];
const rb = (s: AutomationRunbook["steps"][number]): AutomationRunbook => ({ id: "rb1", name: "rb", type: "automation", matches: "", steps: [s] });
const tpl = () => ({ alert: workflowAlert() as Alert });
const aid = workflowAlert().id;

describe("only the step's approvers may decide it", () => {
  it("a member of the approvers group approves", async () => {
    const r = runner();
    await r.start(rb(step("Restart", "oncall")), tpl());
    const run = await r.approve(aid, 0, { actor: "marek", runbookId: "rb1" });
    expect(run.steps[0]!.state).not.toBe("awaiting_approval");
  });

  it("anyone else is refused (approve and skip), and the step keeps waiting", async () => {
    const r = runner();
    await r.start(rb(step("Restart", "oncall")), tpl());
    for (const decision of ["approve", "skip"] as const) {
      const err = await r.approve(aid, 0, { actor: "anna", runbookId: "rb1", decision }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RunnerError);
      expect((err as RunnerError).code).toBe("forbidden");
    }
    expect((await r.listRuns(aid))[0]!.steps[0]!.state).toBe("awaiting_approval");
  });

  it("steps without an approvers group (or with an unknown one) stay open to anyone", async () => {
    const r = runner();
    await r.start(rb(step("Restart")), tpl());
    expect((await r.approve(aid, 0, { actor: "anna", runbookId: "rb1" })).steps[0]!.state).not.toBe("awaiting_approval");
    const r2 = runner();
    await r2.start(rb(step("Restart", "no-such-group")), tpl());
    expect((await r2.approve(aid, 0, { actor: "anna", runbookId: "rb1" })).steps[0]!.state).not.toBe("awaiting_approval");
  });
});
