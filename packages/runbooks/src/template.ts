import type { Alert, Event } from "@alerting/shared";

/** Browser-safe: no node imports. */
export interface TemplateContext {
  alert?: Alert;
  event?: Event;
}

const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;

function getPath(root: unknown, segs: string[]): unknown {
  let cur = root;
  for (const s of segs) {
    if (cur === null || typeof cur !== "object" || !Object.hasOwn(cur, s)) return undefined;
    cur = (cur as Record<string, unknown>)[s];
  }
  return cur;
}

function firstDefined(...vals: unknown[]): unknown {
  return vals.find((v) => v !== undefined && v !== null);
}

function resolvePath(path: string, ctx: TemplateContext): unknown {
  const segs = path.split(".");
  const [head, ...rest] = segs;
  if (head === "alert" && rest.length > 0) {
    const a = ctx.alert;
    if (!a) return undefined;
    if (rest.length === 1 && rest[0] === "status") return a.state;
    return firstDefined(getPath(a, rest), getPath(a.common, rest));
  }
  if (head === "event" && rest.length > 0) return getPath(ctx.event, rest);
  const e = ctx.event;
  if (!e) return undefined;
  return firstDefined(
    getPath(e.parsed, segs),
    typeof e.raw === "object" ? getPath(e.raw, segs) : undefined,
    getPath(e.common, segs),
  );
}

function render(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function renderTemplate(text: string, ctx: TemplateContext): string {
  return text.replace(PLACEHOLDER, (_m, path: string) => (path ? render(resolvePath(path, ctx)) : ""));
}

/** Distinct placeholder paths used in the text, in order of first use. */
export function templateFields(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(PLACEHOLDER)) {
    const p = m[1];
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}
