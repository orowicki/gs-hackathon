import { evaluate, type FilterNode } from "@alerting/filter";
import type { Event } from "@alerting/shared";
import type { AlertsApiDeps } from "../common.js";
import { compileFilterToSql } from "./sql-filter.js";
import { alertContext } from "./filter-context.js";
import { addToSummary, emptySummary, type AlertSummary } from "./store.js";

const BATCH = 200;
const SCAN_CAP = 5000;

/**
 * Without a filter: one aggregate SQL query. With a filter that compiles to SQL: a grouped
 * count in Postgres over all matching alerts (no SCAN_CAP, like the unfiltered summary).
 * Otherwise the filter language is evaluated in Node (as for the list): alerts are scanned
 * newest-first with the same cap as `GET /api/alerts`.
 */
export async function computeSummary(
  deps: AlertsApiDeps,
  tree: FilterNode | null,
  needsEvents: boolean,
): Promise<AlertSummary> {
  if (!tree) return deps.alerts.summary();
  const compiled = !needsEvents && deps.alerts.summaryWhere ? compileFilterToSql(tree) : null;
  if (compiled) return deps.alerts.summaryWhere!(compiled);
  const out = emptySummary();
  let scanned = 0;
  let cursor: { lastSeen: string; id: string } | undefined;
  while (scanned < SCAN_CAP) {
    const batch = await deps.alerts.list({ before: cursor, limit: BATCH });
    if (batch.length === 0) break;
    let events = new Map<string, Event>();
    if (needsEvents) events = await deps.events!.getEvents([...new Set(batch.map((a) => a.eventId))]);
    for (const a of batch) {
      if (scanned++ >= SCAN_CAP) break;
      if (evaluate(tree, alertContext(a, events.get(a.eventId)))) addToSummary(out, a);
    }
    if (batch.length < BATCH) break;
    cursor = { lastSeen: batch[batch.length - 1]!.lastSeen, id: batch[batch.length - 1]!.id };
  }
  return out;
}
