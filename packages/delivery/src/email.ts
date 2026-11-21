import nodemailer from "nodemailer";
import type { Channel, ChannelResult, QueuedNotification } from "./channel.js";

export interface EmailOptions {
  host: string;
  port: number;
  from: string;
  /** Externally reachable base URL of the alerting web/API (for click and ack links). */
  publicUrl: string;
  secure?: boolean;
  user?: string;
  pass?: string;
  /**
   * Maps recipient id to an address. Person has no email field yet, so the default is
   * `${recipientId}@${toDomain}`; Mailpit catches every address.
   */
  toFor?: (recipientId: string) => string;
  /** Domain for the default address (default "alerting.local"). */
  toDomain?: string;
  timeoutMs?: number;
}

export interface EmailEnvConfig {
  host: string;
  port: number;
  from: string;
  secure: boolean;
  user?: string;
  pass?: string;
  toDomain: string;
  publicUrl: string;
}

export function emailConfigFromEnv(env: Record<string, string | undefined> = process.env): EmailEnvConfig {
  const port = Number(env.SMTP_PORT);
  return {
    host: env.SMTP_HOST || "localhost",
    port: Number.isInteger(port) && port > 0 ? port : 1025,
    from: env.SMTP_FROM || "alerting@alerting.local",
    secure: env.SMTP_SECURE === "1" || env.SMTP_SECURE?.toLowerCase() === "true",
    user: env.SMTP_USER || undefined,
    pass: env.SMTP_PASS || undefined,
    toDomain: env.SMTP_TO_DOMAIN || "alerting.local",
    publicUrl: env.PUBLIC_URL || "http://localhost:3000",
  };
}

function safeHttpUrl(u: string): string | undefined {
  try {
    const p = new URL(u).protocol;
    return p === "http:" || p === "https:" ? u : undefined;
  } catch {
    return undefined;
  }
}

const CONNECTION_CODES = new Set([
  "ECONNECTION",
  "ETIMEDOUT",
  "ESOCKET",
  "EDNS",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
]);

class InvalidRecipientError extends Error {
  constructor() {
    super("invalid recipient id for email");
  }
}

export function buildEmail(n: QueuedNotification, publicUrl: string): { subject: string; text: string } {
  const pub = publicUrl.replace(/\/+$/, "");
  const abs = (u: string): string | undefined => {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) return safeHttpUrl(u);
    if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return undefined;
    return `${pub}${u.startsWith("/") ? "" : "/"}${u}`;
  };
  const lines: string[] = [];
  if (n.body) lines.push(n.body, "");
  const click = n.clickUrl ? abs(n.clickUrl) : undefined;
  if (click) lines.push(`Open: ${click}`);
  const runbook = n.runbookUrl ? safeHttpUrl(n.runbookUrl) : undefined;
  if (runbook) lines.push(`Runbook: ${runbook}`);
  // The ack API is POST-only (and a GET link would be unsafe under mail-scanner prefetch), so link to the app.
  lines.push(`Acknowledge in the app: ${pub}/alerts/${encodeURIComponent(n.alertId)}`);
  const oneLine = (s: string): string => s.replace(/[\r\n]+/g, " ");
  return { subject: `[${n.severity.toUpperCase()}] ${oneLine(n.title)}`, text: lines.join("\n") + "\n" };
}

export function classifyEmailError(e: unknown): ChannelResult {
  const err = e as { code?: string; responseCode?: number; message?: string };
  const error = `email send failed: ${err?.message ?? String(e)}`;
  const rc = err?.responseCode;
  const code = err?.code;
  if (code && CONNECTION_CODES.has(code)) return { status: "failed", retryable: true, unavailable: true, error };
  if (typeof rc === "number") {
    if (rc === 421) return { status: "failed", retryable: true, unavailable: true, error };
    return { status: "failed", retryable: rc >= 400 && rc < 500, error };
  }
  if (code === "EAUTH" || code === "EENVELOPE") return { status: "failed", retryable: false, error };
  // Unknown errors consume attempts and eventually dead-letter rather than looping forever.
  return { status: "failed", retryable: true, error };
}

export function createEmailChannel(opts: EmailOptions): Channel {
  const t = opts.timeoutMs ?? 5000;
  const transport = nodemailer.createTransport({
    host: opts.host,
    port: opts.port,
    secure: opts.secure ?? false,
    ...(opts.user ? { auth: { user: opts.user, pass: opts.pass ?? "" } } : {}),
    connectionTimeout: t,
    greetingTimeout: t,
    socketTimeout: t,
  });
  const toDomain = opts.toDomain ?? "alerting.local";
  const toFor =
    opts.toFor ??
    ((r: string) => {
      if (!/^[A-Za-z0-9._+-]+$/.test(r)) throw new InvalidRecipientError();
      return `${r}@${toDomain}`;
    });
  return {
    id: "email",
    async send(n) {
      try {
        const { subject, text } = buildEmail(n, opts.publicUrl);
        const to = toFor(n.recipientId);
        await transport.sendMail({ from: opts.from, to, subject, text });
        return { status: "delivered" };
      } catch (e) {
        if (e instanceof InvalidRecipientError) return { status: "failed", retryable: false, error: e.message };
        return classifyEmailError(e);
      }
    },
  };
}
