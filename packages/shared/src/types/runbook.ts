import type { Id } from "./common.js";
import type { Filter } from "./filter.js";

export type ApprovalMode = "none" | "required";

/**
 * Fields every step may carry, on top of its action's own fields.
 * - `id` names the step so later steps can refer to it as `steps.<id>.*` in `if`.
 * - `if` is a filter (same language as rules) checked when the step is reached; false = the step is skipped.
 *   It sees the event's fields, `alert.*`, `steps.<id>.ok|state|status|attempts|result|body.*` and `previous.*`.
 *   A step with an `if` also runs after an earlier step failed (that is how failure branches are written);
 *   a step without one is skipped once a step has failed.
 * - `retries` re-runs a failed step up to N more times before it counts as failed.
 */
export interface StepCommon {
  id?: string;
  if?: string;
  retries?: number;
}

export interface HttpStep extends StepCommon {
  action: "http";
  name?: string;
  method: string;
  url: string;
  headers?: Record<string, string>;
  /** Templated, e.g. {"workflowId":"{{workflowId}}"}. */
  body?: string;
  approval: ApprovalMode;
  /** Group id to notify (with an Approve button) when this step awaits approval; default: the alert's own recipients. */
  approvers?: Id;
}
export interface EscalateStep extends StepCommon {
  action: "escalate";
  name?: string;
  /** Group id to notify. */
  group: Id;
  approval: ApprovalMode;
  /** Group id to notify (with an Approve button) when this step awaits approval; default: the alert's own recipients. */
  approvers?: Id;
}
export interface WaitStep extends StepCommon {
  action: "wait";
  name?: string;
  /** e.g. "2m", "30s". */
  duration: string;
  approval: ApprovalMode;
  /** Group id to notify (with an Approve button) when this step awaits approval; default: the alert's own recipients. */
  approvers?: Id;
}
/** Action types are plugins; these are the built-ins. */
export type RunbookStep = HttpStep | EscalateStep | WaitStep;

export interface TextRunbook {
  id: Id;
  name: string;
  type: "text";
  matches: Filter;
  /** Markdown/free text/link with {{field}} placeholders. Never executed. */
  content: string;
}
export interface AutomationRunbook {
  id: Id;
  name: string;
  type: "automation";
  matches: Filter;
  steps: RunbookStep[];
}
export type Runbook = TextRunbook | AutomationRunbook;

export type StepRunState = "pending" | "awaiting_approval" | "running" | "done" | "failed" | "skipped";

/** Run state of one runbook against one alert. */
export interface RunbookRun {
  alertId: Id;
  runbookId: Id;
  steps: Array<{
    index: number;
    state: StepRunState;
    result?: string;
    at?: string;
    /** How many times the action ran (more than 1 with `retries`). */
    attempts?: number;
    /** HTTP status of the last attempt (http steps). */
    status?: number;
    /** Parsed JSON response of the last attempt (http steps), for `if: steps.<id>.body.*`. */
    body?: unknown;
  }>;
}

export interface PendingApproval {
  alertId: Id;
  runbookId: Id;
  stepIndex: number;
  stepName?: string;
  /** Group id whose members may approve or skip (from the run's runbook snapshot); absent = any signed-in account. */
  approvers?: Id;
  requestedAt: string;
}
