import type http from "node:http";
import { randomUUID } from "node:crypto";
import type { UiPush } from "@alerting/shared";
import type { AlertStore, AuditStore, EventLoader, RulebookStore, SuggestionStore } from "./alerts/store.js";

export interface AlertsApiDeps {
  alerts: AlertStore;
  audit: AuditStore;
  suggestions: SuggestionStore;
  /** "How to resolve" texts per rule; omitted = no rulebook (resolve still works). */
  rulebook?: RulebookStore;
  events?: EventLoader;
  publish?(push: UiPush): void;
  now?(): Date;
  newId?(): string;
}

export const MAX_BODY_BYTES = 64 * 1024;

export function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

/** Read a small JSON body. Empty body -> `{}`. Throws BodyError on bad/too large input. */
export class BodyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const text = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on("data", (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        done = true;
        chunks.length = 0;
        reject(new BodyError(413, "payload too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!done) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (e) => {
      if (!done) reject(e);
    });
  });
  if (text.trim() === "") return {};
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new BodyError(400, "invalid JSON body");
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new BodyError(400, "body must be a JSON object");
  return v as Record<string, unknown>;
}

/** Actor/author: body field, else x-actor header, else "anonymous". Trimmed, max 200 chars. */
export function resolveActor(req: http.IncomingMessage, bodyValue: unknown): string {
  const header = req.headers["x-actor"];
  const candidates = [bodyValue, Array.isArray(header) ? header[0] : header];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim() !== "") return c.trim().slice(0, 200);
  }
  return "anonymous";
}

export function nowIso(deps: AlertsApiDeps): string {
  return (deps.now?.() ?? new Date()).toISOString();
}

export function newId(deps: AlertsApiDeps): string {
  return deps.newId?.() ?? randomUUID();
}

export function decodeSegment(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

export function parseLimit(raw: string | null, def: number, max: number): number {
  const n = raw === null ? NaN : Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(1, Math.floor(n)));
}

/** Respond to a BodyError. 413 closes the connection and destroys the request once the response is flushed. */
export function sendBodyError(req: http.IncomingMessage, res: http.ServerResponse, e: BodyError): void {
  if (e.status !== 413) return sendJson(res, e.status, { error: e.message });
  const payload = JSON.stringify({ error: e.message });
  res.writeHead(413, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    connection: "close",
  });
  res.end(payload, () => req.destroy());
}
