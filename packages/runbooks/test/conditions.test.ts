import { describe, expect, it } from "vitest";
import type { Alert, AutomationRunbook } from "@alerting/shared";
import { createActionRegistry, createMemoryRunStore, createRunner, validateRunbook } from "../src/index.js";
import type { ActionPlugin } from "../src/index.js";
import { workflowAlert, workflowEvent } from "./helpers.js";

/** Action "t": fails while `failures[name]` > 0 (counting down), returns `data[name]` as the JSON body. */
function setup(opts: { failures?: Record<string, number>; data?: Record<string, unknown> } = {}) {
  const failures = { ...opts.failures };
  const log: string[] = [];
  const plugin: ActionPlugin = {
    type: "t",
    async execute(step) {
      const n = step.name ?? "";
      log.push(n);
      if ((failures[n] ?? 0) > 0) {
        failures[n]!--;
        return { ok: false, result: `${n} boom`, status: 500 };
      }
      return { ok: true, result: `ran ${n}`, status: 200, data: opts.data?.[n] };
    },
  };
  const runner = createRunner({
    store: createMemoryRunStore(),
    actions: createActionRegistry([plugin]),
    retryDelayMs: 0,
    sleep: async () => undefined,
  });
  return { runner, log };
}
type Step = AutomationRunbook["steps"][number];
const step = (name: string, extra: Record<string, unknown> = {}) => ({ action: "t", name, approval: "none", ...extra }) as unknown as Step;
const rb = (...steps: Step[]): AutomationRunbook => ({ id: "rb1", name: "rb", type: "automation", matches: "", steps });
const tpl = () => ({ alert: workflowAlert() as Alert, event: workflowEvent() });
const aid = workflowAlert().id;

describe("conditional steps", () => {
  it("retry fails twice → escalate (the settlement-timeout example)", async () => {
    const { runner, log } = setup({ failures: { retry: 2 } });
    const run = await runner.start(
      rb(
        step("check"),
        step("retry", { id: "retry", retries: 1 }),
        step("escalate", { if: "steps.retry.ok = false" }),
        step("close ticket", { if: "steps.retry.ok = true" }),
      ),
      tpl(),
    );
    expect(log).toEqual(["check", "retry", "retry", "escalate"]);
    expect(run.steps.map((s) => s.state)).toEqual(["done", "failed", "done", "skipped"]);
    expect(run.steps[1]).toMatchObject({ attempts: 2, result: "failed 2 of 2 attempts: retry boom" });
    expect(run.steps[3]!.result).toBe("condition not met: steps.retry.ok = true");
    // The failure was handled by the escalate branch.
    expect(run.status).toBe("done");
    const audit = await runner.listAudit({ alertId: aid });
    expect(audit.filter((e) => e.stepIndex === 1).map((e) => e.result)).toEqual([
      "attempt 1 of 2 failed: retry boom",
      "failed 2 of 2 attempts: retry boom",
    ]);
  });

  it("retry succeeds on the second attempt → escalate is skipped", async () => {
    const { runner, log } = setup({ failures: { retry: 1 } });
    const run = await runner.start(
      rb(step("retry", { id: "retry", retries: 1 }), step("escalate", { if: "steps.retry.ok = false", approval: "required" })),
      tpl(),
    );
    expect(log).toEqual(["retry", "retry"]);
    expect(run.steps.map((s) => s.state)).toEqual(["done", "skipped"]);
    expect(run.steps[0]!.attempts).toBe(2);
    expect(run.status).toBe("done");
  });

  it("a condition is checked before approval: approval is only asked when the branch applies", async () => {
    const { runner } = setup({ failures: { retry: 1 } });
    const run = await runner.start(
      rb(step("retry", { id: "retry" }), step("escalate", { if: "steps.retry.ok = false", approval: "required" })),
      tpl(),
    );
    expect(run.status).toBe("awaiting_approval");
    expect(run.steps.map((s) => s.state)).toEqual(["failed", "awaiting_approval"]);
    const done = await runner.approve(aid, 1, { actor: "anna" });
    expect(done.steps.map((s) => s.state)).toEqual(["failed", "done"]);
    expect(done.status).toBe("done");
  });

  it("branches on the JSON response of an earlier step (one region vs all regions)", async () => {
    for (const [scope, expected] of [
      ["one-region", ["done", "done", "skipped"]],
      ["all-regions", ["done", "skipped", "done"]],
    ] as const) {
      const { runner } = setup({ data: { regions: { scope, failing: ["eu-west"] } } });
      const run = await runner.start(
        rb(
          step("regions", { id: "regions" }),
          step("failover", { if: 'steps.regions.body.scope = "one-region"' }),
          step("rollback", { if: 'steps.regions.body.scope = "all-regions"' }),
        ),
        tpl(),
      );
      expect(run.steps.map((s) => s.state)).toEqual(expected);
    }
  });

  it("conditions see event fields, alert fields and previous", async () => {
    const { runner, log } = setup();
    const run = await runner.start(
      rb(
        step("a"),
        step("prod only", { if: "environment = prod AND previous.ok = true" }),
        step("staging only", { if: "environment = staging" }),
        step("by alert", { if: `alert.id = "${aid}"` }),
      ),
      tpl(),
    );
    expect(log).toEqual(["a", "prod only", "by alert"]);
    expect(run.status).toBe("done");
  });

  it("without an if, steps after a failure are still skipped and the run fails", async () => {
    const { runner, log } = setup({ failures: { a: 1 } });
    const run = await runner.start(rb(step("a"), step("b"), step("c", { if: "previous.ok = false" })), tpl());
    expect(log).toEqual(["a", "c"]);
    expect(run.steps.map((s) => s.state)).toEqual(["failed", "skipped", "done"]);
    expect(run.steps[1]!.result).toBe("skipped after step 1 failed");
  });

  it("an unhandled failure leaves the run failed", async () => {
    const { runner } = setup({ failures: { a: 1 } });
    const run = await runner.start(rb(step("a", { id: "a" }), step("b", { if: "steps.a.ok = true" })), tpl());
    expect(run.steps.map((s) => s.state)).toEqual(["failed", "skipped"]);
    expect(run.status).toBe("failed");
  });
});

describe("validateRunbook: id, if, retries", () => {
  const base = { id: "x", name: "x", type: "automation", matches: "" };
  const v = (steps: unknown[]) => validateRunbook({ ...base, steps });
  it("accepts them", () => {
    expect(v([{ action: "wait", duration: "1s", id: "w", retries: 2 }, { action: "wait", duration: "1s", if: "steps.w.ok = false" }]).ok).toBe(true);
  });
  it("rejects bad ones", () => {
    expect(v([{ action: "wait", duration: "1s", if: "steps.w.ok = (" }])).toMatchObject({ ok: false });
    expect(v([{ action: "wait", duration: "1s", id: "has space" }])).toMatchObject({ ok: false });
    expect(v([{ action: "wait", duration: "1s", id: "a" }, { action: "wait", duration: "1s", id: "a" }])).toMatchObject({ ok: false });
    expect(v([{ action: "wait", duration: "1s", retries: 9 }])).toMatchObject({ ok: false });
  });
});

describe("removing a runbook from an alert", () => {
  it("skips steps not yet run, records it in the audit, and restore undoes the flag", async () => {
    const { runner, log } = setup();
    const r = rb(step("a"), step("b", { approval: "required" }), step("c"));
    await runner.start(r, tpl());
    expect(await runner.listPendingApprovals()).toHaveLength(1);

    const run = await runner.remove(aid, "rb1", "anna");
    expect(run!.steps.map((s) => s.state)).toEqual(["done", "skipped", "skipped"]);
    expect(run!.steps[1]!.result).toBe("runbook removed by anna");
    expect(await runner.listPendingApprovals()).toHaveLength(0);
    expect([...(await runner.removedRunbooks(aid))]).toEqual(["rb1"]);
    expect(log).toEqual(["a"]);

    await runner.restore(aid, "rb1", "anna");
    expect((await runner.removedRunbooks(aid)).size).toBe(0);
    const audit = await runner.listAudit({ alertId: aid });
    expect(audit.filter((e) => e.action.startsWith("runbook_")).map((e) => [e.action, e.actor])).toEqual([
      ["runbook_removed", "anna"],
      ["runbook_restored", "anna"],
    ]);
  });

  it("works for runbooks without a run (text runbooks)", async () => {
    const { runner } = setup();
    expect(await runner.remove(aid, "some-text-runbook", "ewa")).toBeUndefined();
    expect([...(await runner.removedRunbooks(aid))]).toEqual(["some-text-runbook"]);
  });
});
