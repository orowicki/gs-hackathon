import { z, type ZodRawShape } from "zod";

export interface PromptDef {
  name: string;
  title: string;
  description: string;
  args: ZodRawShape;
  render(args: Record<string, string | undefined>): string;
}

export const AUTOMATION_EXAMPLE = `{
  "id": "payments-restart",
  "name": "Restart payments-api",
  "type": "automation",
  "matches": "alert.source = payments-api AND alert.severity = critical",
  "steps": [
    { "action": "http", "id": "restart", "name": "Restart service", "method": "POST", "url": "https://ops.example.com/restart", "body": "{\\"service\\":\\"{{source}}\\"}", "approval": "required", "retries": 2 },
    { "action": "wait", "name": "Let it settle", "duration": "2m", "approval": "none" },
    { "action": "escalate", "name": "Page on-call if restart failed", "if": "steps.restart.ok = false", "group": "oncall", "approval": "none" }
  ]
}`;

export const STEP_FORMAT = `An automation runbook is an object: { id, name, type: "automation", matches, steps }.
- id: non-empty string. name: non-empty string.
- matches: filter text selecting alerts, e.g. \`alert.source = payments-api AND alert.severity = critical\`.
- steps: ordered array (at least one). Every step has \`action\` and optional \`approval\` ("none" default, or "required" = pauses until a person approves), \`approvers\` (group id to notify for approval), \`name\`, \`id\` (letters, digits, _; unique; lets later steps use steps.<id>.ok), \`if\` (filter; false = skip; e.g. steps.restart.ok = false), \`retries\` (integer 0-5).
- action "http": needs \`method\` and \`url\`; optional \`headers\` (string map) and \`body\` (string, {{field}} placeholders allowed).
- action "escalate": needs \`group\` (id of the group to notify).
- action "wait": needs \`duration\` like 30s, 2m, 1h (maximum 15m).
Only these three actions exist. Instructions that need a human (look at a dashboard, decide something) do not become steps: keep them in a text runbook or in a step with approval "required".`;

/** Pure: build the prompt text for converting a text runbook into an automation runbook. */
export function renderConvertTextRunbook(args: { text?: string; runbookId?: string; name?: string }): string {
  const target = args.runbookId
    ? `Update the existing runbook "${args.runbookId}": first call get_runbook with that id, then save the result with update_runbook (same id, full object).`
    : `Save the result as a new runbook with create_runbook${args.name ? ` (name: "${args.name}")` : ""}; choose a short kebab-case id.`;
  return `Convert the following text runbook into an automation runbook for the alerting system.

## Text runbook

${args.text ?? "(no text given: ask the user to paste the runbook)"}

## Automation runbook format

${STEP_FORMAT}

## Example of a valid automation runbook

${AUTOMATION_EXAMPLE}

## What to do

1. Turn each automatable instruction into a step; use "approval": "required" for risky actions. Pick \`matches\` from the text (use validate_filter to check it).
2. ${target}
3. If the API returns a validation error, read the message, fix the runbook and call the tool again until it is saved.
4. Finish by telling the user which steps were created and which instructions could not be automated.`;
}

export const PROMPTS: PromptDef[] = [
  {
    name: "convert_text_runbook",
    title: "Convert a text runbook to an automation runbook",
    description: "Turn a free-text runbook into an automation runbook (http/escalate/wait steps) and save it with create_runbook or update_runbook.",
    args: {
      text: z.string().describe("The text runbook to convert"),
      runbookId: z.string().optional().describe("Id of an existing runbook to update instead of creating a new one"),
      name: z.string().optional().describe("Name for the new runbook"),
    },
    render: (a) => renderConvertTextRunbook(a),
  },
];
