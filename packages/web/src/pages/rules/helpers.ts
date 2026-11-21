import { print, type FilterNode } from "@alerting/filter";
import type { Filter, RecipientRef, Rule, Severity } from "@alerting/shared";

export interface WhoDraft {
  condition: string;
  /** Comma separated `person:id` / `group:id` (a bare id means person). */
  recipients: string;
  /** Comma separated channel ids. */
  force: string;
}

export interface RuleDraft {
  name: string;
  enabled: boolean;
  when: string;
  who: WhoDraft[];
  titleTemplate: string;
  bodyTemplate: string;
  fields: string;
  severityOverride: string;
  colour: string;
}

export const SEVERITY_OPTIONS: Severity[] = ["critical", "error", "warning", "info"];

export function emptyDraft(): RuleDraft {
  return {
    name: "",
    enabled: true,
    when: "",
    who: [],
    titleTemplate: "{{alert.title}}",
    bodyTemplate: "",
    fields: "",
    severityOverride: "",
    colour: "",
  };
}

export function filterText(f: Filter | undefined): string {
  if (f === undefined || f === null) return "";
  if (typeof f === "string") return f;
  try {
    return print(f as FilterNode);
  } catch {
    return JSON.stringify(f);
  }
}

export function splitList(s: string): string[] {
  return s
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x !== "");
}

export function parseRecipients(s: string): RecipientRef[] {
  return splitList(s).map((tok) => {
    const i = tok.indexOf(":");
    if (i > 0) {
      const kind = tok.slice(0, i).trim();
      const id = tok.slice(i + 1).trim();
      if (kind === "group" || kind === "person") return { type: kind, id };
    }
    return { type: "person", id: tok };
  });
}

export function recipientsText(r: RecipientRef[]): string {
  return r.map((x) => `${x.type}:${x.id}`).join(", ");
}

export function ruleToDraft(rule: Rule): RuleDraft {
  return {
    name: rule.name,
    enabled: rule.enabled,
    when: filterText(rule.when),
    who: rule.who.map((w) => ({
      condition: filterText(w.condition),
      recipients: recipientsText(w.recipients),
      force: (w.force ?? []).join(", "),
    })),
    titleTemplate: rule.looks.titleTemplate,
    bodyTemplate: rule.looks.bodyTemplate ?? "",
    fields: rule.looks.fields.join(", "),
    severityOverride: rule.looks.severityOverride ?? "",
    colour: rule.looks.colour ?? "",
  };
}

export type RulePayload = Pick<Rule, "name" | "enabled" | "when" | "who" | "looks">;

export function buildPayload(d: RuleDraft): RulePayload {
  const looks: RulePayload["looks"] = { titleTemplate: d.titleTemplate, fields: splitList(d.fields) };
  if (d.bodyTemplate.trim() !== "") looks.bodyTemplate = d.bodyTemplate;
  if (d.severityOverride !== "") looks.severityOverride = d.severityOverride as Severity;
  if (d.colour.trim() !== "") looks.colour = d.colour.trim();
  return {
    name: d.name.trim(),
    enabled: d.enabled,
    when: d.when.trim(),
    who: d.who.map((w) => {
      const row: RulePayload["who"][number] = { recipients: parseRecipients(w.recipients) };
      if (w.condition.trim() !== "") row.condition = w.condition.trim();
      const force = splitList(w.force);
      if (force.length > 0) row.force = force;
      return row;
    }),
    looks,
  };
}

/** Returns a list of problems; empty when the draft can be saved. */
export function validateDraft(d: RuleDraft): string[] {
  const errs: string[] = [];
  if (d.name.trim() === "") errs.push("Name is required.");
  if (d.titleTemplate.trim() === "") errs.push("Title template is required.");
  d.who.forEach((w, i) => {
    if (parseRecipients(w.recipients).length === 0) errs.push(`Who row ${i + 1} needs at least one recipient.`);
  });
  return errs;
}

export function moveRow<T>(rows: readonly T[], from: number, to: number): T[] {
  if (to < 0 || to >= rows.length || from < 0 || from >= rows.length) return [...rows];
  const out = [...rows];
  const [x] = out.splice(from, 1);
  out.splice(to, 0, x as T);
  return out;
}

export function shortText(s: string, max = 60): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}
