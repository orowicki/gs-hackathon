import type { AuditEntry, AutomationRunbook, PendingApproval, RunbookRun } from "@alerting/shared";
import { stepDisplayName } from "./actions.js";
import type { TemplateContext } from "./template.js";

export type RunStatus = "running" | "awaiting_approval" | "done" | "failed";

export type StoredRun = RunbookRun & {
  /** Runbook snapshot at start. */
  runbook: AutomationRunbook;
  /** Template context snapshot at start. */
  template: TemplateContext;
  status: RunStatus;
  /** Optimistic-concurrency counter; incremented by every successful updateRun. */
  version: number;
  createdAt: string;
  updatedAt: string;
};

export interface ListAuditOptions {
  alertId?: string;
  limit?: number;
}

/**
 * Persistence for runs and audit. Audit ordering (always): chronological, oldest first, newest last.
 * With `limit`, the most recent `limit` entries are returned, still oldest-first.
 */
export interface RunStore {
  /** false if a run for (alertId, runbookId) already exists. */
  createRun(run: StoredRun): Promise<boolean>;
  getRun(alertId: string, runbookId: string): Promise<StoredRun | undefined>;
  listRuns(alertId: string): Promise<StoredRun[]>;
  /** Compare-and-set: succeeds only if stored version === run.version; then stores version+1. Returns false on conflict. */
  updateRun(run: StoredRun): Promise<boolean>;
  appendAudit(entry: AuditEntry): Promise<void>;
  listAudit(opts?: ListAuditOptions): Promise<AuditEntry[]>;
  listPendingApprovals(): Promise<PendingApproval[]>;
  /** All runs with status "running". */
  listRunningRuns(): Promise<StoredRun[]>;
}

export function pendingOf(run: StoredRun): PendingApproval[] {
  return run.steps
    .filter((s) => s.state === "awaiting_approval")
    .map((s) => ({
      alertId: run.alertId,
      runbookId: run.runbookId,
      stepIndex: s.index,
      stepName: run.runbook.steps[s.index] ? stepDisplayName(run.runbook.steps[s.index]!, run.template) : undefined,
      requestedAt: s.at ?? run.updatedAt,
    }));
}

export const MAX_AUDIT_LIMIT = 1000;
export function clampLimit(limit: number): number {
  return Math.min(MAX_AUDIT_LIMIT, Math.max(1, Math.floor(limit)));
}

export function tail<T>(xs: T[], limit?: number): T[] {
  return limit !== undefined && limit >= 0 ? xs.slice(Math.max(0, xs.length - limit)) : xs;
}

export function createMemoryRunStore(): RunStore {
  const runs = new Map<string, StoredRun>();
  const audit: AuditEntry[] = [];
  const key = (a: string, r: string) => JSON.stringify([a, r]);
  const copy = <T>(x: T): T => structuredClone(x);
  return {
    async createRun(run) {
      const k = key(run.alertId, run.runbookId);
      if (runs.has(k)) return false;
      runs.set(k, copy(run));
      return true;
    },
    async getRun(a, r) {
      const run = runs.get(key(a, r));
      return run && copy(run);
    },
    async listRuns(a) {
      return [...runs.values()].filter((r) => r.alertId === a).map(copy);
    },
    async updateRun(run) {
      const k = key(run.alertId, run.runbookId);
      const cur = runs.get(k);
      if (!cur || cur.version !== run.version) return false;
      runs.set(k, copy({ ...run, version: run.version + 1 }));
      return true;
    },
    async appendAudit(e) {
      audit.push(copy(e));
    },
    async listAudit({ alertId, limit } = {}) {
      return tail(audit.filter((e) => alertId === undefined || e.alertId === alertId), limit === undefined ? undefined : clampLimit(limit)).map(copy);
    },
    async listPendingApprovals() {
      return [...runs.values()].flatMap(pendingOf);
    },
    async listRunningRuns() {
      return [...runs.values()].filter((r) => r.status === "running").map(copy);
    },
  };
}
