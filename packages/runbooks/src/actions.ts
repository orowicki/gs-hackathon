import type { EscalateStep, HttpStep, RunbookStep, WaitStep } from "@alerting/shared";
import { renderTemplate, type TemplateContext } from "./template.js";

export interface ActionContext {
  template: TemplateContext;
  render(s: string): string;
  alertId: string;
  runbookId: string;
  stepIndex: number;
  signal?: AbortSignal;
}
export interface ActionResult {
  ok: boolean;
  /** Short human-readable outcome. */
  result: string;
}
export interface ActionPlugin {
  type: string;
  execute(step: RunbookStep, ctx: ActionContext): Promise<ActionResult>;
}
export interface ActionRegistry {
  register(plugin: ActionPlugin): void;
  get(type: string): ActionPlugin | undefined;
  types(): string[];
}

export function createActionRegistry(plugins: ActionPlugin[] = []): ActionRegistry {
  const map = new Map<string, ActionPlugin>();
  const reg: ActionRegistry = {
    register: (p) => void map.set(p.type, p),
    get: (t) => map.get(t),
    types: () => [...map.keys()],
  };
  plugins.forEach(reg.register);
  return reg;
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

export function parseDuration(d: string): number {
  const m = /^(\d+)(ms|s|m|h)$/.exec(d.trim());
  if (!m) throw new Error(`invalid duration "${d}"`);
  const mult = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] as "ms" | "s" | "m" | "h"];
  return Number(m[1]) * mult;
}

export interface HttpActionOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}
export function httpAction(opts: HttpActionOptions = {}): ActionPlugin {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return {
    type: "http",
    async execute(raw, ctx) {
      const step = raw as HttpStep;
      const url = ctx.render(step.url);
      const label = `${step.method} ${url}`;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(step.headers ?? {})) headers[k] = ctx.render(v);
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
      try {
        const res = await doFetch(url, {
          method: step.method,
          headers,
          body: step.body !== undefined && !/^(GET|HEAD)$/i.test(step.method) ? ctx.render(step.body) : undefined,
          signal,
        });
        const text = truncate((await res.text()).trim(), 200);
        return { ok: res.status >= 200 && res.status < 300, result: `${label} → ${res.status}${text ? ` ${text}` : ""}` };
      } catch (e) {
        return { ok: false, result: `${label} failed: ${errMsg(e)}` };
      }
    },
  };
}

export interface NotifyInfo {
  alertId: string;
  runbookId: string;
  stepIndex: number;
  template: TemplateContext;
}
export interface EscalateActionOptions {
  notifyGroup?: (groupId: string, info: NotifyInfo) => Promise<string | void>;
}
export function escalateAction(opts: EscalateActionOptions = {}): ActionPlugin {
  return {
    type: "escalate",
    async execute(raw, ctx) {
      const group = ctx.render((raw as EscalateStep).group);
      if (!opts.notifyGroup) return { ok: false, result: `cannot notify group ${group}: no notifier configured` };
      try {
        const msg = await opts.notifyGroup(group, {
          alertId: ctx.alertId,
          runbookId: ctx.runbookId,
          stepIndex: ctx.stepIndex,
          template: ctx.template,
        });
        return { ok: true, result: msg || `notified group ${group}` };
      } catch (e) {
        return { ok: false, result: `notifying group ${group} failed: ${errMsg(e)}` };
      }
    },
  };
}

export interface WaitActionOptions {
  sleep?: (ms: number) => Promise<void>;
}
export function waitAction(opts: WaitActionOptions = {}): ActionPlugin {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return {
    type: "wait",
    async execute(raw) {
      const d = (raw as WaitStep).duration;
      try {
        await sleep(parseDuration(d));
        return { ok: true, result: `waited ${d}` };
      } catch (e) {
        return { ok: false, result: errMsg(e) };
      }
    },
  };
}

export interface DefaultActionDeps extends HttpActionOptions, EscalateActionOptions, WaitActionOptions {}
export function createDefaultActions(deps: DefaultActionDeps = {}): ActionRegistry {
  return createActionRegistry([
    httpAction({ fetch: deps.fetch, timeoutMs: deps.timeoutMs }),
    escalateAction({ notifyGroup: deps.notifyGroup }),
    waitAction({ sleep: deps.sleep }),
  ]);
}

/** Display name of a step: rendered `name`, or a default like "http GET <url>". */
export function stepDisplayName(step: RunbookStep, template: TemplateContext): string {
  if (step.name) return renderTemplate(step.name, template);
  const s = step as unknown as Record<string, unknown>;
  switch (step.action) {
    case "http":
      return `http ${step.method} ${renderTemplate(step.url, template)}`;
    case "escalate":
      return `escalate to ${step.group}`;
    case "wait":
      return `wait ${step.duration}`;
    default:
      return String((s as { action?: unknown }).action);
  }
}
