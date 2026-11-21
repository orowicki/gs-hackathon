import { describe, expect, it } from "vitest";
import type { Alert, AutomationRunbook } from "@alerting/shared";
import { createActionRegistry, createMemoryRunStore, createRunner, RunnerError } from "../src/index.js";
import type { ActionPlugin } from "../src/index.js";
import { workflowAlert } from "./helpers.js";

function setup(failOn?: string) {
  const log: string[] = [];
  const plugin: ActionPlugin = {
    type: "t",
    async execute(step, ctx) {
      const n = step.name ?? "";
      log.push(n);
      return n === failOn ? { ok: false, result: "boom" } : { ok: true, result: `ran ${ctx.render(n)}` };
    },
  };
  let id = 0;
  const updates: string[] = [];
  const runner = createRunner({
    store: createMemoryRunStore(),
    actions: createActionRegistry([plugin]),
    newId: () => `id${++id}`,
    onUpdate: (r) => updates.push(r.status),
  });
  return { runner, log, updates };
}
const step = (name: string, approval: "none" | "required" = "none") =>
  ({ action: "t", name, approval }) as unknown as AutomationRunbook["steps"][number];
const rb = (...steps: AutomationRunbook["steps"]): AutomationRunbook => ({ id: "rb1", name: "rb", type: "automation", matches: "", steps });
const tpl = () => ({ alert: workflowAlert() as Alert });
const aid = workflowAlert().id;

describe("runner", () => {
  it("runs auto steps in order with system audit", async () => {
    const { runner, log, updates } = setup();
    const run = await runner.start(rb(step("a"), step("b")), tpl());
    expect(run.status).toBe("done");
    expect(run.steps.map((s) => s.state)).toEqual(["done", "done"]);
    expect(log).toEqual(["a", "b"]);
    const audit = await runner.listAudit({ alertId: aid });
    expect(audit.map((e) => [e.action, e.actor, e.stepIndex, e.detail])).toEqual([
      ["step_executed", "system", 0, "a"],
      ["step_executed", "system", 1, "b"],
    ]);
    expect(new Date(audit[0]!.at).toISOString()).toBe(audit[0]!.at);
    expect(updates.at(-1)).toBe("done");
  });

  it("required step waits, then approve runs it and the rest", async () => {
    const { runner, log } = setup();
    const run = await runner.start(rb(step("a"), step("b", "required"), step("c")), tpl());
    expect(run.status).toBe("awaiting_approval");
    expect(run.steps.map((s) => s.state)).toEqual(["done", "awaiting_approval", "pending"]);
    expect(log).toEqual(["a"]);
    expect(await runner.listPendingApprovals()).toMatchObject([{ alertId: aid, runbookId: "rb1", stepIndex: 1, stepName: "b" }]);
    const done = await runner.approve(aid, 1, { actor: "p-alice" });
    expect(done.status).toBe("done");
    expect(log).toEqual(["a", "b", "c"]);
    const audit = await runner.listAudit({ alertId: aid });
    expect(audit.map((e) => [e.action, e.actor])).toEqual([
      ["step_executed", "system"],
      ["step_approved", "p-alice"],
      ["step_executed", "p-alice"],
      ["step_executed", "system"],
    ]);
    expect(await runner.listPendingApprovals()).toEqual([]);
    expect(await runner.listAudit({ limit: 2 })).toHaveLength(2);
  });

  it("skip decision", async () => {
    const { runner, log } = setup();
    await runner.start(rb(step("a", "required"), step("b")), tpl());
    const run = await runner.approve(aid, 0, { actor: "p-bob", decision: "skip", runbookId: "rb1" });
    expect(run.steps.map((s) => s.state)).toEqual(["skipped", "done"]);
    expect(run.status).toBe("done");
    expect(log).toEqual(["b"]);
    const audit = await runner.listAudit({ alertId: aid });
    expect(audit[0]).toMatchObject({ action: "step_skipped", actor: "p-bob", stepIndex: 0 });
  });

  it("failure skips the rest", async () => {
    const { runner, log } = setup("b");
    const run = await runner.start(rb(step("a"), step("b"), step("c"), step("d", "required")), tpl());
    expect(run.status).toBe("failed");
    expect(run.steps.map((s) => s.state)).toEqual(["done", "failed", "skipped", "skipped"]);
    expect(log).toEqual(["a", "b"]);
    const audit = await runner.listAudit({ alertId: aid });
    expect(audit.filter((e) => e.action === "step_skipped").map((e) => [e.actor, e.result])).toEqual([
      ["system", "skipped after step 2 failed"],
      ["system", "skipped after step 2 failed"],
    ]);
  });

  it("failure of an approved step fails the run", async () => {
    const { runner } = setup("b");
    await runner.start(rb(step("b", "required"), step("c")), tpl());
    const run = await runner.approve(aid, 0, { actor: "p" });
    expect(run.steps.map((s) => s.state)).toEqual(["failed", "skipped"]);
    expect(run.status).toBe("failed");
  });

  it("unknown action fails", async () => {
    const { runner } = setup();
    const run = await runner.start(rb({ action: "nope", approval: "none" } as never), tpl());
    expect(run.steps[0]).toMatchObject({ state: "failed", result: "unknown action nope" });
  });

  it("start is idempotent", async () => {
    const { runner, log } = setup();
    const a = await runner.start(rb(step("a")), tpl());
    const b = await runner.start(rb(step("a")), tpl());
    expect(b).toEqual(a);
    expect(log).toEqual(["a"]);
    expect(await runner.listRuns(aid)).toHaveLength(1);
  });

  it("double approve: second gets not_awaiting", async () => {
    const { runner, log } = setup();
    await runner.start(rb(step("a", "required")), tpl());
    const results = await Promise.allSettled([
      runner.approve(aid, 0, { actor: "p1", runbookId: "rb1" }),
      runner.approve(aid, 0, { actor: "p2", runbookId: "rb1" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rej = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rej.reason).toBeInstanceOf(RunnerError);
    expect(rej.reason.code).toBe("not_awaiting");
    expect(log).toEqual(["a"]);
    await expect(runner.approve(aid, 0, { actor: "p3" })).rejects.toMatchObject({ code: "not_awaiting" });
  });

  it("wrong step / unknown alert / ambiguous", async () => {
    const { runner } = setup();
    await runner.start(rb(step("a"), step("b", "required")), tpl());
    await expect(runner.approve(aid, 0, { actor: "p" })).rejects.toMatchObject({ code: "not_awaiting" });
    await expect(runner.approve(aid, 9, { actor: "p", runbookId: "rb1" })).rejects.toMatchObject({ code: "not_awaiting" });
    await expect(runner.approve("nope", 1, { actor: "p" })).rejects.toMatchObject({ code: "not_found" });
    await expect(runner.approve(aid, 1, { actor: "p", runbookId: "zzz" })).rejects.toMatchObject({ code: "not_found" });
    await runner.start({ ...rb(step("a"), step("b", "required")), id: "rb2" }, tpl());
    await expect(runner.approve(aid, 1, { actor: "p" })).rejects.toMatchObject({ code: "ambiguous" });
  });
});
