import type { Event } from "@alerting/shared";

/** Pre-alert view of an event: common fields (no `status`) plus `schema`. */
export function alertView(event: Event): Record<string, unknown> {
  const c = event.common as Record<string, unknown>;
  const view: Record<string, unknown> = {};
  for (const k of [
    "title",
    "source",
    "environment",
    "dedupKey",
    "sourceStatus",
    "occurredAt",
    "type",
    "message",
    "entity",
    "runbookUrl",
  ]) {
    if (c[k] !== undefined && c[k] !== null) view[k] = c[k];
  }
  view.severity = c.severity ?? "info";
  view.schema = event.schemaId;
  return view;
}
