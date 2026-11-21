import http from "node:http";
import type { ChannelStatus, DeadLetter, Notification } from "@alerting/shared";
import { HttpIngestRegistry, handleHttpIngest } from "@alerting/ingest";
import { buildOpenApi } from "./openapi.js";
import { serveStatic } from "./static.js";
import { handleAlertsRoutes } from "./routes/alerts/http.js";
import { handleSuggestionsRoutes } from "./routes/suggestions/http.js";
import { handleStream } from "./stream/sse.js";
import { handleEventsRoutes, type EventsApiDeps } from "./routes/events/http.js";
import type { AlertsApiDeps } from "./routes/common.js";

export type { AlertsApiDeps };

export interface DeliveryDeps {
  listDeadLetters(): Promise<DeadLetter[]>;
  retryDeadLetter(id: string): Promise<Notification | null>;
  channelStatus(): Promise<ChannelStatus[]>;
}

export interface Deps {
  checkPostgres(): Promise<boolean>;
  checkRedis(): Promise<boolean>;
  delivery?: DeliveryDeps;
  /** Alerts, audit and suggestions routes; omitted = those paths 404. */
  alerts?: AlertsApiDeps;
  /** Subscribe to CHANNEL_UI_PUSH messages; returns an unsubscribe function. */
  subscribeUiPush?(onMessage: (json: string) => void): () => void;
  /** Recent events source; omitted = /api/events/recent and /test-filter 404. */
  recentEvents?: EventsApiDeps["recentEvents"];
  /** SSE heartbeat interval (ms), default 15000. */
  ssePingMs?: number;
  /** Directory with the built web app; defaults to env WEB_DIST. */
  webDist?: string;
}

const CHECK_TIMEOUT_MS = 2000;

async function runCheck(fn: () => Promise<boolean>): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), CHECK_TIMEOUT_MS);
  });
  try {
    return await Promise.race([fn().catch(() => false), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

export const MAX_INGEST_BYTES = 10 * 1024 * 1024;

/** Read the request body as UTF-8 text; resolves undefined (and destroys the request) when it exceeds the limit. */
function readBody(
  req: http.IncomingMessage,
  limit: number,
  onTooBig: () => void,
): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on("data", (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > limit) {
        done = true;
        chunks.length = 0;
        onTooBig();
        resolve(undefined);
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!done) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (e) => (done ? undefined : reject(e)));
  });
}

function tooLarge(req: http.IncomingMessage, res: http.ServerResponse): void {
  const payload = JSON.stringify({ error: "payload too large" });
  res.writeHead(413, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    connection: "close",
  });
  res.end(payload, () => req.destroy());
}

async function handleIngest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sourceId: string,
): Promise<void> {
  try {
    if (!HttpIngestRegistry.has(sourceId))
      return send(res, 404, { error: "unknown source" });
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > MAX_INGEST_BYTES)
      return tooLarge(req, res);
    let overflow = false;
    const body = await readBody(req, MAX_INGEST_BYTES, () => {
      overflow = true;
      tooLarge(req, res);
    });
    if (overflow || body === undefined) return;
    const type = req.headers["content-type"];
    const out = await handleHttpIngest(sourceId, body, type);
    if ("error" in out) {
      if (out.error === "unknown_source")
        return send(res, 404, { error: "unknown source" });
      if (out.error === "empty") return send(res, 400, { error: "empty body" });
      if (!("message" in out)) return send(res, 500, { error: "internal error" });
      console.error("ingest emit failed:", out.message);
      return send(res, 500, { accepted: out.accepted, error: "emit failed" });
    }
    send(res, 202, out);
  } catch (err) {
    console.error("ingest route failed:", err);
    send(res, 500, { error: "internal error" });
  }
}

export function createServer(deps: Deps): http.Server {
  const server = http.createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (req.method === "GET" && path === "/health") {
      void (async () => {
        const [postgres, redis] = await Promise.all([
          runCheck(deps.checkPostgres),
          runCheck(deps.checkRedis),
        ]);
        const ok = postgres && redis;
        send(res, ok ? 200 : 503, { ok, checks: { postgres, redis } });
      })();
      return;
    }
    if (req.method === "GET" && path === "/api/openapi.json") {
      send(res, 200, buildOpenApi());
      return;
    }
    const retryMatch = /^\/api\/dead-letters\/([^/]+)\/retry$/.exec(path);
    const notConfigured = (): void => send(res, 503, { error: "delivery not configured" });
    const fail = (): void => send(res, 500, { error: "internal error" });
    if (req.method === "GET" && path === "/api/dead-letters") {
      if (!deps.delivery) return notConfigured();
      deps.delivery.listDeadLetters().then((v) => send(res, 200, v), fail);
      return;
    }
    if (req.method === "POST" && retryMatch) {
      if (!deps.delivery) return notConfigured();
      let id: string;
      try {
        id = decodeURIComponent(retryMatch[1]);
      } catch {
        return send(res, 400, { error: "bad id" });
      }
      deps.delivery.retryDeadLetter(id).then(
        (n) => (n ? send(res, 200, n) : send(res, 404, { error: "dead letter not found" })),
        fail,
      );
      return;
    }
    if (req.method === "GET" && path === "/api/channels") {
      if (!deps.delivery) return notConfigured();
      deps.delivery.channelStatus().then((v) => send(res, 200, v), fail);
      return;
    }
    if (req.method === "GET" && path === "/api/stream") {
      handleStream(req, res, deps.subscribeUiPush, deps.ssePingMs);
      return;
    }
    const m = req.method === "POST" ? /^\/ingest\/([^/]+)$/.exec(path) : null;
    if (m) {
      let id: string;
      try {
        id = decodeURIComponent(m[1]!);
      } catch {
        return send(res, 400, { error: "bad source id" });
      }
      void handleIngest(req, res, id);
      return;
    }
    const webDist = deps.webDist ?? process.env.WEB_DIST;
    if (
      webDist &&
      (req.method === "GET" || req.method === "HEAD") &&
      path !== "/api" &&
      !path.startsWith("/api/") &&
      serveStatic(req, res, webDist)
    ) {
      return;
    }
    if (
      deps.recentEvents &&
      (path === "/api/events/recent" || path === "/api/events/test-filter")
    ) {
      const recentEvents = deps.recentEvents;
      void (async () => {
        try {
          const url = new URL(req.url ?? "/", "http://localhost");
          if (await handleEventsRoutes(req, res, path, url, { recentEvents })) return;
          send(res, 404, { error: "not found" });
        } catch (err) {
          console.error("events route failed:", err);
          if (!res.headersSent) send(res, 500, { error: "internal error" });
        }
      })();
      return;
    }
    if (
      deps.alerts &&
      (path.startsWith("/api/alerts") ||
        path === "/api/audit" ||
        (path.startsWith("/api/rules/") && path.endsWith("/suggestions")) ||
        path.startsWith("/api/suggestions/"))
    ) {
      const alertsDeps = deps.alerts;
      void (async () => {
        try {
          const url = new URL(req.url ?? "/", "http://localhost");
          if (await handleAlertsRoutes(req, res, path, url, alertsDeps)) return;
          if (await handleSuggestionsRoutes(req, res, path, url, alertsDeps)) return;
          send(res, 404, { error: "not found" });
        } catch (err) {
          console.error("alerts route failed:", err);
          if (!res.headersSent) send(res, 500, { error: "internal error" });
        }
      })();
      return;
    }
    send(res, 404, { error: "not found" });
  });
  server.requestTimeout = 30_000;
  return server;
}
