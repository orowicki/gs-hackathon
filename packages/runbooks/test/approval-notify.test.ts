import { describe, expect, it } from "vitest";
import type { Alert, AutomationRunbook } from "@alerting/shared";
import { validateRunbook } from "../src/index.js";
import { createActionRegistry, createApprovalNotifier, createMemoryRunStore, createRunner } from "../src/index.js";
import type { ActionPlugin, ApprovalNotification } from "../src/index.js";
import { workflowAlert } from "./helpers.js";

const plugin: ActionPlugin = { type: "t", execute: async () => ({ ok: true, result: "ok" }) };

function setup() {
  const sent: ApprovalNotification[] = [];
  const asked: Array<string | undefined> = [];
  const notify = createApprovalNotifier({
    recipients: async (_a, approvers) => {
      asked.push(approvers);
      return [
        { recipientId: "p1", channel: "ui" },
        { recipientId: "p1", channel: "ntfy" },
        { recipientId: "p1", channel: "ntfy" },
        { recipientId: "p2", channel: "ui" },
      ];
    },
    enqueue: async (n) => void sent.push(n),
  });
  const runner = createRunner({
    store: createMemoryRunStore(),
    actions: createActionRegistry([plugin]),
    onAwaitingApproval: notify,
  });
  return { runner, sent, asked };
}
const step = (name: string, approval: "none" | "required" = "none", approvers?: string) =>
  ({ action: "t", name, approval, approvers }) as unknown as AutomationRunbook["steps"][number];
const rb = (...steps: AutomationRunbook["steps"]): AutomationRunbook => ({ id: "rb1", name: "rb", type: "automation", matches: "", steps });
const tpl = () => ({ alert: workflowAlert() as Alert });
const aid = workflowAlert().id;

describe("approval notifications", () => {
  it("sends one notification per approver and channel", async () => {
    const { runner, sent, asked } = setup();
    await runner.start(rb(step("a"), step("Do it", "required", "grp")), tpl());
    expect(sent.map((n) => `${n.recipientId}/${n.channel}`)).toEqual(["p1/ui", "p1/ntfy", "p2/ui"]);
    for (const n of sent) {
      expect(n.approveStepIndex).toBe(1);
      expect(n.alertId).toBe(aid);
      expect(n.title).toContain("Do it");
      expect(n.clickUrl).toBe(`/alerts/${aid}`);
    }
    expect(new Set(sent.map((n) => n.id)).size).toBe(3);
    expect(asked).toEqual(["grp"]);
  });

  it("sends none when no step needs approval", async () => {
    const { runner, sent } = setup();
    await runner.start(rb(step("a"), step("b")), tpl());
    expect(sent).toEqual([]);
  });

  it("notifies again for a later approval step", async () => {
    const { runner, sent, asked } = setup();
    await runner.start(rb(step("one", "required", "g1"), step("two", "required", "g2")), tpl());
    expect(new Set(sent.map((n) => n.approveStepIndex))).toEqual(new Set([0]));
    sent.length = 0;
    await runner.approve(aid, 0, { actor: "u" });
    expect(sent.length).toBe(3);
    expect(new Set(sent.map((n) => n.approveStepIndex))).toEqual(new Set([1]));
    expect(sent[0]!.title).toContain("two");
    expect(asked).toEqual(["g1", "g2"]);
  });

  it("never fails the run when notifying throws", async () => {
    const errors: string[] = [];
    const runner = createRunner({
      store: createMemoryRunStore(),
      actions: createActionRegistry([plugin]),
      onAwaitingApproval: async () => {
        throw new Error("down");
      },
      onError: (e) => errors.push(e.message),
    });
    const run = await runner.start(rb(step("x", "required")), tpl());
    expect(run.status).toBe("awaiting_approval");
    expect(errors).toEqual(["down"]);
  });

  it("validates approvers on steps", () => {
    const base = { id: "r", name: "n", type: "automation", matches: "", steps: [{ action: "escalate", group: "g", approval: "required" }] };
    const withApprovers = (approvers: unknown) => ({ ...base, steps: [{ ...base.steps[0], approvers }] });
    const ok = validateRunbook(withApprovers("grp"));
    expect(ok.ok && (ok.runbook as AutomationRunbook).steps[0]!.approvers).toBe("grp");
    expect(validateRunbook(withApprovers("")).ok).toBe(false);
    expect(validateRunbook(withApprovers(5)).ok).toBe(false);
  });
});
