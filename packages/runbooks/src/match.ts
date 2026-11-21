import { evaluate, tryParse } from "@alerting/filter";
import { parseDuration } from "./actions.js";
import { conditionError } from "./conditions.js";
import type { Alert, Event, FilterNode, Runbook } from "@alerting/shared";

export interface MatchContext {
  alert: Alert;
  event?: Event;
}

const cache = new Map<string, FilterNode | null | undefined>();

/** undefined = unparseable. */
function treeOf(f: Runbook["matches"] | null | undefined): FilterNode | null | undefined {
  if (f === null || f === undefined) return null;
  if (typeof f !== "string") return f;
  if (cache.has(f)) return cache.get(f);
  const r = tryParse(f);
  const tree = r.ok ? r.tree : undefined;
  if (cache.size > 1000) cache.clear();
  cache.set(f, tree);
  return tree;
}

function alertContext(alert: Alert): Record<string, unknown> {
  return { ...alert.common, ...alert, status: alert.state, schema: alert.schemaId };
}

export function matchRunbooks(runbooks: Runbook[], ctx: MatchContext): Runbook[] {
  const evalCtx = { alert: alertContext(ctx.alert), event: ctx.event?.parsed };
  return runbooks.filter((rb) => {
    try {
      const tree = treeOf(rb.matches);
      if (tree === undefined) return false;
      return evaluate(tree, evalCtx);
    } catch {
      return false;
    }
  });
}

export const DEFAULT_MAX_WAIT_MS = 15 * 60_000;
const DURATION = /^\d+(ms|s|m|h)$/;
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export type ValidateResult = { ok: true; runbook: Runbook } | { ok: false; error: string };

export function validateRunbook(x: unknown, opts: { maxWaitMs?: number } = {}): ValidateResult {
  const maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const fail = (error: string): ValidateResult => ({ ok: false, error });
  if (!isObj(x)) return fail("runbook must be an object");
  if (!isStr(x.id)) return fail("id must be a non-empty string");
  if (!isStr(x.name)) return fail("name must be a non-empty string");
  if (x.matches !== undefined && x.matches !== null && typeof x.matches !== "string" && !isObj(x.matches))
    return fail("matches must be filter text or a filter tree");
  const matches = (x.matches ?? "") as Runbook["matches"];
  if (x.type === "text") {
    if (typeof x.content !== "string") return fail("text runbook needs a content string");
    return { ok: true, runbook: { ...x, matches } as unknown as Runbook };
  }
  if (x.type !== "automation") return fail('type must be "text" or "automation"');
  if (!Array.isArray(x.steps)) return fail("automation runbook needs a steps array");
  const steps: unknown[] = [];
  const seenIds = new Set<string>();
  for (const [i, raw] of x.steps.entries()) {
    const at = `steps[${i}]`;
    if (!isObj(raw)) return fail(`${at} must be an object`);
    if (typeof raw.action !== "string" || !raw.action) return fail(`${at}.action must be a string`);
    const approval = raw.approval ?? "none";
    if (approval !== "none" && approval !== "required") return fail(`${at}.approval must be "none" or "required"`);
    if (raw.approvers !== undefined && !isStr(raw.approvers)) return fail(`${at}.approvers must be a non-empty string (group id)`);
    if (raw.action === "http" && (!isStr(raw.method) || !isStr(raw.url)))
      return fail(`${at}: http step needs method and url`);
    if (raw.action === "escalate" && !isStr(raw.group)) return fail(`${at}: escalate step needs group`);
    if (raw.action === "wait" && !(typeof raw.duration === "string" && DURATION.test(raw.duration)))
      return fail(`${at}: wait step needs duration like 30s, 2m, 1h`);
    if (raw.action === "wait") {
      const ms = parseDuration(raw.duration as string);
      if (ms > maxWaitMs) return fail(`${at}: wait duration ${raw.duration} exceeds the maximum of ${maxWaitMs}ms`);
    }
    if (raw.id !== undefined && !(typeof raw.id === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(raw.id)))
      return fail(`${at}.id must be a name like retry or check_health (letters, digits, _)`);
    if (raw.id !== undefined && seenIds.has(raw.id as string)) return fail(`${at}.id "${raw.id as string}" is used twice`);
    if (raw.id !== undefined) seenIds.add(raw.id as string);
    if (raw.if !== undefined) {
      if (!isStr(raw.if)) return fail(`${at}.if must be a filter, e.g. steps.retry.ok = false`);
      const err = conditionError(raw.if);
      if (err) return fail(`${at}.if: ${err}`);
    }
    if (raw.retries !== undefined && !(Number.isInteger(raw.retries) && (raw.retries as number) >= 0 && (raw.retries as number) <= 5))
      return fail(`${at}.retries must be a whole number from 0 to 5`);
    steps.push({ ...raw, approval });
  }
  return { ok: true, runbook: { ...x, matches, steps } as unknown as Runbook };
}
