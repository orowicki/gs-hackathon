import { evaluate, print, tryParse, type FilterNode } from "@alerting/filter";
import type { Alert, Filter, StarredFilter } from "@alerting/shared";

/** Alert as the filter language sees it: the field alert.NAME reads from ctx.alert. */
export function alertContext(alert: Alert): { alert: Record<string, unknown>; event: Record<string, unknown> } {
  const fromFields: Record<string, unknown> = {};
  for (const f of alert.fields) {
    const key = labelKey(f.label);
    if (key) fromFields[key] = f.value;
  }
  return {
    alert: {
      ...fromFields,
      ...alert.common,
      id: alert.id,
      severity: alert.severity,
      title: alert.title,
      source: alert.source,
      environment: alert.environment,
      // alert.status is our lifecycle (open/acknowledged/resolved); the source's firing/resolved is sourceStatus.
      // TODO: drop the common.status fallback once shared renames the field to sourceStatus.
      sourceStatus: (alert.common as Record<string, unknown>).sourceStatus ?? alert.common.status,
      status: alert.state,
      state: alert.state,
      count: alert.count,
      ruleId: alert.ruleId,
      schema: alert.schemaId,
    },
    event: {},
  };
}

/** "First name" becomes "firstName". */
export function labelKey(label: string): string {
  const words = label.split(/[^A-Za-z0-9]+/).filter(Boolean);
  return words.map((w, i) => (i === 0 ? w.toLowerCase() : w[0]!.toUpperCase() + w.slice(1).toLowerCase())).join("");
}

export function byNewest(a: Alert, b: Alert): number {
  return Date.parse(b.lastSeen) - Date.parse(a.lastSeen);
}

/** Inserts or replaces an alert (matched by id) and keeps the list newest first. Does not mutate. */
export function upsertAlert(list: readonly Alert[], alert: Alert): Alert[] {
  const next = list.filter((a) => a.id !== alert.id);
  next.push(alert);
  return next.sort(byNewest);
}

export function sortAlerts(list: readonly Alert[]): Alert[] {
  return [...list].sort(byNewest);
}

const LABELS = { critical: "CRIT", error: "ERR", warning: "WARN", info: "INFO" } as const;
export function severityLabel(s: Alert["severity"]): string {
  return LABELS[s] ?? "INFO";
}

/** now, 45s, 2m, 3h, 4d. */
export function relativeTime(iso: string, now: number): string {
  const sec = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (sec < 10) return "now";
  if (sec < 60) return sec + "s";
  const min = Math.floor(sec / 60);
  if (min < 60) return min + "m";
  const h = Math.floor(min / 60);
  if (h < 24) return h + "h";
  return Math.floor(h / 24) + "d";
}

/** Field names for the filter bar: server suggestions plus every alert.* key seen. */
export function fieldNames(alerts: readonly Alert[], suggested: readonly string[] = []): string[] {
  const set = new Set<string>(suggested);
  for (const a of alerts) for (const k of Object.keys(alertContext(a).alert)) set.add("alert." + k);
  return [...set].sort();
}

/** Distinct values of a field across alerts, most recent first, at most limit. */
export function valuesFor(alerts: readonly Alert[], field: string, limit = 20): string[] {
  if (!field.startsWith("alert.")) return [];
  const key = field.slice(6);
  const out = new Set<string>();
  for (const a of sortAlerts(alerts)) {
    const v = alertContext(a).alert[key];
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out.add(String(v));
    if (out.size >= limit) break;
  }
  return [...out];
}

/** Text form of a stored filter (text or tree). */
export function filterText(f: Filter): string {
  return typeof f === "string" ? f : print(f);
}

export function newStarred(personId: string, text: string): StarredFilter {
  const id = "star-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
  return { id, personId, name: text, filter: text };
}

/** Parses filter text for display. Empty text is valid and matches everything. */
export function parseFilter(text: string): { ok: true; tree: FilterNode | null } | { ok: false; message: string } {
  const r = tryParse(text);
  return r.ok ? { ok: true, tree: r.tree } : { ok: false, message: r.error.message };
}

/** Alerts that match the tree (null matches all). Keeps the input order. */
export function filterAlerts(alerts: readonly Alert[], tree: FilterNode | null): Alert[] {
  if (!tree) return [...alerts];
  return alerts.filter((a) => evaluate(tree, alertContext(a)));
}

/** Text of starred filters, from stored StarredFilter entries. */
export function starredTexts(list: readonly StarredFilter[]): string[] {
  return list.map((s) => filterText(s.filter));
}
