import http from "node:http";
import type { ChannelStatus, DeadLetter, Notification } from "@alerting/shared";
import { buildOpenApi } from "./openapi.js";

export interface DeliveryDeps {
  listDeadLetters(): Promise<DeadLetter[]>;
  retryDeadLetter(id: string): Promise<Notification | null>;
  channelStatus(): Promise<ChannelStatus[]>;
}

export interface Deps {
  checkPostgres(): Promise<boolean>;
  checkRedis(): Promise<boolean>;
  delivery?: DeliveryDeps;
  /** Subscribe to CHANNEL_UI_PUSH messages; returns an unsubscribe function. */
  subscribeUiPush?(onMessage: (json: string) => void): () => void;
}

const SSE_PING_MS = 15_000;

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

export function createServer(deps: Deps): http.Server {
  return http.createServer((req, res) => {
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
      if (!deps.subscribeUiPush) return notConfigured();
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(": connected\n\n");
      const unsubscribe = deps.subscribeUiPush((json) => {
        res.write(`data: ${json}\n\n`);
      });
      const ping = setInterval(() => res.write(": ping\n\n"), SSE_PING_MS);
      let closed = false;
      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(ping);
        unsubscribe();
      };
      req.on("close", cleanup);
      res.on("close", cleanup);
      return;
    }
    send(res, 404, { error: "not found" });
  });
}
