import type { Severity } from "@alerting/shared";
import type { Channel, ChannelResult, QueuedNotification } from "./channel.js";

export interface NtfyOptions {
  /** ntfy server root, e.g. http://ntfy:80 */
  baseUrl: string;
  /** Externally reachable base URL of the alerting web/API (for click and action targets). */
  publicUrl: string;
  /** Maps recipient id to ntfy topic. Default `alerting-${recipientId}`. */
  topicFor?: (recipientId: string) => string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export const NTFY_PRIORITY: Record<Severity, number> = { critical: 5, error: 4, warning: 3, info: 2 };

export function ntfyPriority(s: Severity): number {
  return NTFY_PRIORITY[s] ?? 3;
}

function safeHttpUrl(u: string | undefined): string | undefined {
  if (!u) return undefined;
  try {
    const p = new URL(u).protocol;
    return p === "http:" || p === "https:" ? u : undefined;
  } catch {
    return undefined;
  }
}

function trimSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

export function buildNtfyBody(n: QueuedNotification, o: Pick<NtfyOptions, "publicUrl" | "topicFor">): Record<string, unknown> {
  const pub = trimSlash(o.publicUrl);
  const abs = (u: string): string | undefined => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(u) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) return undefined;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) return safeHttpUrl(u);
    return `${pub}${u.startsWith("/") ? "" : "/"}${u}`;
  };
  const aid = encodeURIComponent(n.alertId);
  const topic = (o.topicFor ?? ((r: string) => `alerting-${r}`))(n.recipientId);
  const actions: Record<string, unknown>[] = [
    { action: "http", label: "Acknowledge", url: `${pub}/api/alerts/${aid}/ack`, method: "POST", clear: true },
  ];
  if (Number.isInteger(n.approveStepIndex) && (n.approveStepIndex as number) >= 0) {
    actions.push({
      action: "http",
      label: "Approve",
      url: `${pub}/api/alerts/${aid}/runbook-steps/${n.approveStepIndex}/approve`,
      method: "POST",
      clear: true,
    });
  }
  let message = n.body ?? "";
  if (n.runbookUrl) {
    message += `${message ? "\n" : ""}Runbook: ${n.runbookUrl}`;
    const rb = abs(n.runbookUrl);
    if (rb && actions.length < 3) actions.push({ action: "view", label: "Runbook", url: rb });
  }
  return {
    topic,
    title: n.title,
    message,
    priority: ntfyPriority(n.severity),
    ...(abs(n.clickUrl) ? { click: abs(n.clickUrl) } : {}),
    actions,
    tags: [n.severity],
  };
}

export function classifyStatus(status: number): ChannelResult {
  if (status >= 200 && status < 300) return { status: "delivered" };
  const error = `ntfy responded HTTP ${status}`;
  if (status >= 500 || status === 429) return { status: "failed", retryable: true, unavailable: true, error };
  return { status: "failed", retryable: false, error };
}

export function createNtfyChannel(opts: NtfyOptions): Channel {
  const doFetch = opts.fetch ?? fetch;
  return {
    id: "ntfy",
    async send(n) {
      try {
        const res = await doFetch(trimSlash(opts.baseUrl) + "/", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(buildNtfyBody(n, opts)),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
        });
        await res.arrayBuffer().catch(() => undefined);
        return classifyStatus(res.status);
      } catch (e) {
        return { status: "failed", retryable: true, unavailable: true, error: `ntfy request failed: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
  };
}
