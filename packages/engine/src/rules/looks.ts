import type { Event, Rule, Severity } from "@alerting/shared";
import { isSeverity } from "@alerting/shared";
import { alertView } from "./event-view.js";

export interface RenderedLooks {
  title: string;
  body?: string;
  fields: Array<{ path: string; value: string }>;
  severity: Severity;
  colour?: string;
}

function getPath(root: unknown, path: string): unknown {
  let cur = root;
  for (const seg of path.split(".")) {
    if (cur === null || typeof cur !== "object" || !Object.hasOwn(cur, seg)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function show(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Look up a path: `alert.x` / bare common name, else a raw parsed path. */
export function lookup(event: Event, path: string): unknown {
  const view = alertView(event);
  if (path.startsWith("alert.")) return getPath(view, path.slice(6));
  const raw = getPath(event.parsed, path);
  if (raw !== undefined) return raw;
  return getPath(view, path);
}

export function renderTemplate(tpl: string, event: Event): string {
  return tpl.replace(/\{\{\s*([^{}]*?)\s*\}\}/g, (_m, path: string) => show(lookup(event, path)));
}

export function renderLooks(rule: Rule, event: Event): RenderedLooks {
  const l = rule.looks;
  let title = renderTemplate(l.titleTemplate ?? "", event).trim();
  if (title === "") title = event.common.title || rule.name;
  const body = l.bodyTemplate !== undefined ? renderTemplate(l.bodyTemplate, event) : undefined;
  const sev = l.severityOverride ?? event.common.severity;
  const out: RenderedLooks = {
    title,
    fields: (l.fields ?? []).map((path) => ({ path, value: show(lookup(event, path)) })),
    severity: isSeverity(sev) ? sev : "info",
  };
  if (body !== undefined) out.body = body;
  if (l.colour !== undefined) out.colour = l.colour;
  return out;
}
