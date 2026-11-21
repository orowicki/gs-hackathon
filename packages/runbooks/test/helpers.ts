import { readFileSync } from "node:fs";
import type { Alert, Event, JsonObject } from "@alerting/shared";

const root = new URL("../../../fixtures/", import.meta.url);
const load = (p: string) => JSON.parse(readFileSync(new URL(p, root), "utf8")) as JsonObject;

export function eventOf(file: string): Event {
  const parsed = load(`events/${file}`);
  return { id: "e1", sourceId: "s1", receivedAt: "2026-10-23T09:14:02Z", raw: parsed, parsed, schemaId: null, common: {} };
}
export const workflowEvent = () => eventOf("workflow-failed.json");
export const metricEvent = () => eventOf("metric-breach.json");
export const workflowAlert = () => load("alerts/workflow-failed.json") as unknown as Alert;
