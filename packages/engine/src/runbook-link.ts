import type { RunbookRegistry } from "@alerting/runbooks";
import type { Alert, Event, Notification } from "@alerting/shared";

/**
 * Adds a link to the alert page's runbook section when a text runbook matches the alert.
 * An existing runbookUrl (the event's own) always wins. Skipped without a publicUrl (a host-less link
 * is not clickable in ntfy) and for digests (they cover several alerts). Never throws: on error the
 * notification is returned unchanged.
 */
export function withRunbookLink(
  n: Notification,
  ctx: { alert: Alert; event?: Event },
  registry: Pick<RunbookRegistry, "match">,
  publicUrl: string,
): Notification {
  if (n.runbookUrl || !publicUrl || n.digestAlertIds) return n;
  try {
    if (!registry.match({ alert: ctx.alert, event: ctx.event }).some((r) => r.type === "text")) return n;
  } catch (err) {
    console.error(`engine: runbook match failed: ${err instanceof Error ? err.message : String(err)}`);
    return n;
  }
  return { ...n, runbookUrl: `${publicUrl.replace(/\/+$/, "")}/alerts/${n.alertId}#runbook` };
}
