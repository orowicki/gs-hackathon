import type { Id } from "./common.js";
import type { Filter } from "./filter.js";

export type ApprovalMode = "none" | "required";

export interface HttpStep {
  action: "http";
  name?: string;
  method: string;
  url: string;
  headers?: Record<string, string>;
  /** Templated, e.g. {"workflowId":"{{workflowId}}"}. */
  body?: string;
  approval: ApprovalMode;
}
export interface EscalateStep {
  action: "escalate";
  name?: string;
  /** Group id to notify. */
  group: Id;
  approval: ApprovalMode;
}
export interface WaitStep {
  action: "wait";
  name?: string;
  /** e.g. "2m", "30s". */
  duration: string;
  approval: ApprovalMode;
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
  steps: Array<{ index: number; state: StepRunState; result?: string; at?: string }>;
}

export interface PendingApproval {
  alertId: Id;
  runbookId: Id;
  stepIndex: number;
  stepName?: string;
  requestedAt: string;
}
