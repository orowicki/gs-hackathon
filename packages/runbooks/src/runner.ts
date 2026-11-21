import { randomUUID } from "node:crypto";
import type { Alert, AuditEntry, AutomationRunbook, PendingApproval } from "@alerting/shared";
import { stepDisplayName, type ActionRegistry } from "./actions.js";
import type { ListAuditOptions, RunStore, StoredRun } from "./store.js";
import { renderTemplate, type TemplateContext } from "./template.js";

export type RunnerErrorCode = "not_found" | "not_awaiting" | "ambiguous";
export class RunnerError extends Error {
  constructor(
    public readonly code: RunnerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RunnerError";
  }
}

export interface RunnerOptions {
  store: RunStore;
  actions: ActionRegistry;
  now?: () => Date;
  newId?: () => string;
  onUpdate?: (run: StoredRun) => void;
  /** Called once after a step moves to awaiting_approval. Best effort: errors never fail the run. */
  onAwaitingApproval?: (run: StoredRun, stepIndex: number) => Promise<void>;
  onError?: (err: Error) => void;
}
export interface ApproveOptions {
  actor: string;
  runbookId?: string;
  decision?: "approve" | "skip";
}
export interface Runner {
  start(runbook: AutomationRunbook, template: TemplateContext & { alert: Alert }): Promise<StoredRun>;
  approve(alertId: string, stepIndex: number, opts: ApproveOptions): Promise<StoredRun>;
  listRuns(alertId: string): Promise<StoredRun[]>;
  listAudit(opts?: ListAuditOptions): Promise<AuditEntry[]>;
  listPendingApprovals(): Promise<PendingApproval[]>;
  /** Fail runs stuck in "running" (e.g. after a restart) whose updatedAt is older than the threshold. Returns the count. */
  recoverStale(opts?: { olderThanMs?: number }): Promise<number>;
}

export function createRunner(opts: RunnerOptions): Runner {
  const { store, actions, onUpdate } = opts;
  const now = opts.now ?? (() => new Date());
  const newId = opts.newId ?? randomUUID;
  const iso = () => now().toISOString();

  /** CAS-save; throws not_awaiting on conflict (another actor moved the run). */
  async function save(run: StoredRun): Promise<StoredRun> {
    run.updatedAt = iso();
    if (!(await store.updateRun(run))) {
      throw new RunnerError("not_awaiting", `run ${run.runbookId} for alert ${run.alertId} was modified concurrently`);
    }
    run.version += 1;
    try {
      onUpdate?.(structuredClone(run));
    } catch {
      /* listener errors must not break the run */
    }
    return run;
  }

  const audit = (run: StoredRun, e: Pick<AuditEntry, "actor" | "action" | "stepIndex" | "result" | "detail">) =>
    store.appendAudit({ id: newId(), alertId: run.alertId, at: iso(), runbookId: run.runbookId, ...e });

  function setStep(run: StoredRun, i: number, state: StoredRun["steps"][number]["state"], result?: string) {
    const s = run.steps[i]!;
    s.state = state;
    s.at = iso();
    if (result !== undefined) s.result = result;
  }

  async function execute(run: StoredRun, i: number, actor: string): Promise<boolean> {
    const step = run.runbook.steps[i]!;
    setStep(run, i, "running");
    await save(run);
    const plugin = actions.get(step.action);
    let res: { ok: boolean; result: string };
    if (!plugin) res = { ok: false, result: `unknown action ${step.action}` };
    else {
      try {
        res = await plugin.execute(step, {
          template: run.template,
          render: (s) => renderTemplate(s, run.template),
          alertId: run.alertId,
          runbookId: run.runbookId,
          stepIndex: i,
        });
      } catch (e) {
        res = { ok: false, result: e instanceof Error ? e.message : String(e) };
      }
    }
    setStep(run, i, res.ok ? "done" : "failed", res.result);
    await save(run); // CAS first: no audit entry for a result that was not recorded
    await audit(run, {
      actor,
      action: "step_executed",
      stepIndex: i,
      result: res.result,
      detail: stepDisplayName(step, run.template),
    });
    return res.ok;
  }

  async function skipRest(run: StoredRun, failed: number): Promise<void> {
    const skipped: number[] = [];
    for (const s of run.steps) {
      if (s.state !== "pending") continue;
      setStep(run, s.index, "skipped", `skipped after step ${failed} failed`);
      skipped.push(s.index);
    }
    if (skipped.length === 0) return;
    await save(run);
    for (const i of skipped) {
      await audit(run, {
        actor: "system",
        action: "step_skipped",
        stepIndex: i,
        result: run.steps[i]!.result,
        detail: stepDisplayName(run.runbook.steps[i]!, run.template),
      });
    }
  }

  async function advance(run: StoredRun): Promise<StoredRun> {
    for (;;) {
      const next = run.steps.find((s) => s.state === "pending");
      if (!next) {
        run.status = run.steps.some((s) => s.state === "failed") ? "failed" : "done";
        return save(run);
      }
      if (run.runbook.steps[next.index]!.approval === "required") {
        setStep(run, next.index, "awaiting_approval");
        run.status = "awaiting_approval";
        const saved = await save(run);
        if (opts.onAwaitingApproval) {
          try {
            await opts.onAwaitingApproval(structuredClone(saved), next.index);
          } catch (e) {
            opts.onError?.(e instanceof Error ? e : new Error(String(e)));
          }
        }
        return saved;
      }
      run.status = "running";
      if (!(await execute(run, next.index, "system"))) {
        await skipRest(run, next.index);
        run.status = "failed";
        return save(run);
      }
    }
  }

  return {
    async start(runbook, template) {
      const alertId = template.alert.id;
      const existing = await store.getRun(alertId, runbook.id);
      if (existing) return existing;
      const t = iso();
      const run: StoredRun = {
        alertId,
        runbookId: runbook.id,
        steps: runbook.steps.map((_, index) => ({ index, state: "pending" })),
        runbook: structuredClone(runbook),
        template: structuredClone(template),
        status: "running",
        version: 0,
        createdAt: t,
        updatedAt: t,
      };
      if (!(await store.createRun(run))) return (await store.getRun(alertId, runbook.id))!;
      onUpdate?.(structuredClone(run));
      return advance(run);
    },

    async approve(alertId, stepIndex, o) {
      const decision = o.decision ?? "approve";
      let run: StoredRun | undefined;
      if (o.runbookId !== undefined) {
        run = await store.getRun(alertId, o.runbookId);
        if (!run) throw new RunnerError("not_found", `no run of runbook ${o.runbookId} for alert ${alertId}`);
      } else {
        const runs = await store.listRuns(alertId);
        if (runs.length === 0) throw new RunnerError("not_found", `no runbook runs for alert ${alertId}`);
        const cands = runs.filter((r) => r.steps[stepIndex]?.state === "awaiting_approval");
        if (cands.length > 1) {
          throw new RunnerError("ambiguous", `step ${stepIndex} awaits approval in several runbooks; pass runbookId`);
        }
        run = cands[0];
        if (!run) throw new RunnerError("not_awaiting", `no step ${stepIndex} awaiting approval for alert ${alertId}`);
      }
      if (run.steps[stepIndex]?.state !== "awaiting_approval") {
        throw new RunnerError("not_awaiting", `step ${stepIndex} of ${run.runbookId} is not awaiting approval`);
      }
      const name = stepDisplayName(run.runbook.steps[stepIndex]!, run.template);
      if (decision === "skip") {
        setStep(run, stepIndex, "skipped", `skipped by ${o.actor}`);
        run.status = "running";
        await save(run); // CAS: only one concurrent caller wins
        await audit(run, { actor: o.actor, action: "step_skipped", stepIndex, result: run.steps[stepIndex]!.result, detail: name });
        return advance(run);
      }
      // claim the step (CAS) before doing anything else
      setStep(run, stepIndex, "running");
      run.status = "running";
      await save(run);
      await audit(run, { actor: o.actor, action: "step_approved", stepIndex, detail: name });
      const ok = await execute(run, stepIndex, o.actor);
      if (!ok) {
        await skipRest(run, stepIndex);
        run.status = "failed";
        return save(run);
      }
      return advance(run);
    },

    listRuns: (alertId) => store.listRuns(alertId),
    listAudit: (o) => store.listAudit(o),
    listPendingApprovals: () => store.listPendingApprovals(),

    async recoverStale({ olderThanMs = 10 * 60_000 } = {}) {
      const cutoff = now().getTime() - olderThanMs;
      let n = 0;
      for (const run of await store.listRunningRuns()) {
        if (new Date(run.updatedAt).getTime() > cutoff) continue;
        try {
          const stuck = run.steps.filter((s) => s.state === "running").map((s) => s.index);
          for (const i of stuck) setStep(run, i, "failed", "interrupted (process restarted)");
          const failedAt = stuck[0] ?? run.steps.find((s) => s.state === "pending")?.index ?? 0;
          run.status = "failed";
          await save(run);
          for (const i of stuck) {
            await audit(run, {
              actor: "system",
              action: "step_executed",
              stepIndex: i,
              result: run.steps[i]!.result,
              detail: stepDisplayName(run.runbook.steps[i]!, run.template),
            });
          }
          await skipRest(run, failedAt);
          n++;
        } catch {
          /* modified concurrently: not stale after all */
        }
      }
      return n;
    },
  };
}
