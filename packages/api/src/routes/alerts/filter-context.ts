import type { Alert, Event } from "@alerting/shared";
import type { EvalContext } from "@alerting/filter";

/** Build the filter evaluation context: `alert.*` reads the alert, other paths read the parsed event. */
export function alertContext(alert: Alert, event?: Event | null): EvalContext {
  const a = alert as Alert & { status?: string };
  const state = a.state ?? a.status;
  return {
    alert: {
      ...alert.common,
      severity: alert.severity,
      title: alert.title,
      source: alert.source,
      environment: alert.environment,
      status: state,
      sourceStatus: alert.common?.status,
      schema: alert.schemaId,
      ruleId: alert.ruleId,
      count: alert.count,
      dedupKey: alert.dedupKey,
    },
    event: event ? (event.parsed ?? event.raw) : undefined,
  };
}
