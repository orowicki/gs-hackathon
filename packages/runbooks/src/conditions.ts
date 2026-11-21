import { evaluate, tryParse } from "@alerting/filter";
import type { StoredRun } from "./store.js";

/** What a step's `if` can see about an earlier step. */
export interface StepView {
  ok: boolean;
  failed: boolean;
  state: string;
  attempts: number;
  status?: number;
  result?: string;
  body?: unknown;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function view(s: StoredRun["steps"][number]): StepView {
  return {
    ok: s.state === "done",
    failed: s.state === "failed",
    state: s.state,
    attempts: s.attempts ?? 0,
    ...(s.status !== undefined ? { status: s.status } : {}),
    ...(s.result !== undefined ? { result: s.result } : {}),
    ...(s.body !== undefined ? { body: s.body } : {}),
  };
}

/**
 * Filter context for the `if` of step `index`: `alert.*` reads the alert, bare names read the event
 * (parsed fields, then raw, then common), plus `steps.<id>.*` for earlier steps with an id and
 * `previous.*` for the last earlier step that ran (done or failed).
 */
export function conditionContext(run: StoredRun, index: number): { alert: Record<string, unknown>; event: Record<string, unknown> } {
  const a = run.template.alert;
  const alert: Record<string, unknown> = a ? { ...a.common, ...a, status: a.state, schema: a.schemaId } : {};
  const e = run.template.event;
  const event: Record<string, unknown> = {
    ...(e && isObj(e.common) ? e.common : {}),
    ...(e && isObj(e.raw) ? e.raw : {}),
    ...(e && isObj(e.parsed) ? e.parsed : {}),
  };
  const steps: Record<string, StepView> = {};
  let previous: StepView | undefined;
  for (const s of run.steps) {
    if (s.index >= index) break;
    const id = run.runbook.steps[s.index]?.id;
    if (id) steps[id] = view(s);
    if (s.state === "done" || s.state === "failed") previous = view(s);
  }
  event.steps = steps;
  if (previous) event.previous = previous;
  return { alert, event };
}

export type ConditionResult = { ok: true; value: boolean } | { ok: false; error: string };

export function evaluateCondition(text: string, ctx: { alert: Record<string, unknown>; event: Record<string, unknown> }): ConditionResult {
  const r = tryParse(text);
  if (!r.ok) return { ok: false, error: r.error.message };
  try {
    return { ok: true, value: evaluate(r.tree, ctx) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Syntax check for validation; undefined = fine. */
export function conditionError(text: string): string | undefined {
  const r = tryParse(text);
  return r.ok ? undefined : r.error.message;
}
