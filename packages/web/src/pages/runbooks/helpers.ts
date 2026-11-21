import type { Runbook, RunbookStep } from "@alerting/shared";

/** Intro under "New runbook" and on the list: the same everywhere. */
export const RUNBOOK_INTRO =
  "A runbook tells people what to do when an alert fires: written instructions, or steps the service runs itself, with a person's approval for the risky ones.";

export const ID_RE = /^[a-z0-9][a-z0-9_-]*$/;
export const DURATION_RE = /^\d+(s|m|h)$/;

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export const ACTIONS: { id: RunbookStep["action"]; label: string }[] = [
  { id: "http", label: "HTTP call" },
  { id: "escalate", label: "Escalate" },
  { id: "wait", label: "Wait" },
];

/** A step for the editor: the stored step plus a stable key that is never saved. */
export type DraftStep = RunbookStep & { key: string };
let seq = 0;
export const withKey = (s: RunbookStep): DraftStep => ({ ...s, key: "s" + ++seq });
export function stripKey(s: DraftStep): RunbookStep {
  const out: Partial<DraftStep> = { ...s };
  delete out.key;
  return out as RunbookStep;
}

export function newStep(action: RunbookStep["action"] = "http"): DraftStep {
  if (action === "escalate") return withKey({ action, name: "", group: "", approval: "none" });
  if (action === "wait") return withKey({ action, name: "", duration: "5m", approval: "none" });
  return withKey({ action: "http", name: "", method: "POST", url: "", approval: "none" });
}

/** Change a step's action, keeping its name and approval settings. */
export function switchAction(s: DraftStep, action: RunbookStep["action"]): DraftStep {
  const keep = { key: s.key, name: s.name, approval: s.approval, ...(s.approvers ? { approvers: s.approvers } : {}) };
  if (action === "escalate") return { ...keep, action, group: "" };
  if (action === "wait") return { ...keep, action, duration: "5m" };
  return { ...keep, action: "http", method: "POST", url: "" };
}

export function blankRunbook(): Runbook {
  return { id: "", name: "", type: "automation", matches: "", steps: [] };
}

export interface RunbookExample {
  id: string;
  what: string;
  runbook: Runbook;
}

export const RUNBOOK_EXAMPLES: RunbookExample[] = [
  {
    id: "restart-with-approval",
    what: "Check a service's health, then restart it once a person approves.",
    runbook: {
      id: "restart-with-approval",
      name: "Restart a pricing engine",
      type: "automation",
      matches: "alert.source matches pricing-engine-* AND alert.severity >= error",
      steps: [
        { action: "http", name: "Check {{alert.source}} health", method: "GET", url: "http://demo-service:4100/health", approval: "none" },
        {
          action: "http",
          name: "Restart {{alert.source}}",
          method: "POST",
          url: "http://demo-service:4100/restart/{{alert.source}}",
          body: '{"reason":"{{alert.title}}"}',
          approval: "required",
          approvers: "pricing-team",
        },
        { action: "wait", name: "Let the cache warm up", duration: "30s", approval: "none" },
      ],
    },
  },
  {
    id: "escalate-critical",
    what: "Give the team 5 minutes, then escalate critical alerts to on-call.",
    runbook: {
      id: "escalate-critical",
      name: "Escalate unhandled critical alerts",
      type: "automation",
      matches: "alert.severity = critical",
      steps: [
        { action: "wait", name: "Give the owning team 5 minutes", duration: "5m", approval: "none" },
        { action: "escalate", name: "Page settlements on-call", group: "settlements-oncall", approval: "none" },
      ],
    },
  },
  {
    id: "card-declined-checklist",
    what: "A written checklist shown on declined-payment alerts.",
    runbook: {
      id: "card-declined-checklist",
      name: "Declined card payments",
      type: "text",
      matches: "type = PAYMENT_DECLINED",
      content:
        "## {{alert.title}}\n\n1. Check the payment provider status page.\n2. Look up the last declines for {{alert.source}} in the payments dashboard.\n3. If more than 5% of payments are declined, call the payments lead.\n\nReason given: {{reason}}",
    },
  },
];

/** Pasted or uploaded runbook YAML -> a runbook to review in the editor before saving. */
export function yamlToRunbook(text: string, parse: (t: string) => unknown): Runbook {
  let v: unknown;
  try {
    v = parse(text);
  } catch (e) {
    throw new Error("That isn't valid YAML: " + (e as Error).message.split("\n")[0]);
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Expected one runbook (a YAML mapping with id, name, type, matches).");
  const r = v as Record<string, unknown>;
  if (typeof r.name !== "string" && typeof r.id !== "string") throw new Error("The runbook needs at least a name or an id.");
  const base = {
    id: typeof r.id === "string" ? r.id : slugify(String(r.name)),
    name: typeof r.name === "string" ? r.name : String(r.id),
    matches: (r.matches as Runbook["matches"]) ?? "",
  };
  if (r.type === "text" || (typeof r.content === "string" && !Array.isArray(r.steps)))
    return { ...base, type: "text", content: typeof r.content === "string" ? r.content : "" };
  const steps = (Array.isArray(r.steps) ? r.steps : []).map((s) => ({ approval: "none", ...(s as object) })) as RunbookStep[];
  return { ...base, type: "automation", steps };
}

/** Problems that block saving (empty list = fine). */
export function validateRunbook(r: Runbook, steps: DraftStep[], isNew: boolean): string[] {
  const out: string[] = [];
  if (!r.name.trim()) out.push("Name is required.");
  if (isNew && !ID_RE.test(r.id)) out.push("Id: use lowercase letters, digits, dash or underscore.");
  if (r.type === "text" && !r.content.trim()) out.push("Write the instructions.");
  if (r.type === "automation") {
    if (steps.length === 0) out.push("Add at least one step.");
    steps.forEach((s, i) => {
      const n = `Step ${i + 1}`;
      if (s.action === "http" && !s.url.trim()) out.push(`${n}: the URL is required.`);
      if (s.action === "escalate" && !s.group) out.push(`${n}: choose a group to escalate to.`);
      if (s.action === "wait" && !DURATION_RE.test(s.duration)) out.push(`${n}: use a duration like 30s, 5m or 1h.`);
    });
  }
  return out;
}

/** What a step does, in plain words. */
export function stepSentence(s: RunbookStep, groupName: (id: string) => string): string {
  if (s.action === "http") return `${s.method} ${s.url || "(no URL yet)"}`;
  if (s.action === "escalate") return `Escalate to ${s.group ? groupName(s.group) : "(no group yet)"}`;
  return `Wait ${s.duration}`;
}
