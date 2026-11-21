import http from "node:http";
import { handleHttpIngest } from "@alerting/ingest";
import { buildOpenApi } from "./openapi.js";
import { serveStatic } from "./static.js";

export interface Deps {
  checkPostgres(): Promise<boolean>;
  checkRedis(): Promise<boolean>;
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

/** Read the request body as UTF-8 text; resolves undefined when it exceeds the limit. */
function readBody(req: http.IncomingMessage, limit: number): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) tooBig = true;
      else chunks.push(c);
    });
    req.on("end", () => resolve(tooBig ? undefined : Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handleIngest(req: http.IncomingMessage, res: http.ServerResponse, sourceId: string): Promise<void> {
  try {
    const body = await readBody(req, MAX_INGEST_BYTES);
    if (body === undefined) return send(res, 413, { error: "payload too large" });
    const type = req.headers["content-type"];
    const out = await handleHttpIngest(sourceId, body, type);
    if ("error" in out) {
      return out.error === "unknown_source"
        ? send(res, 404, { error: "unknown source" })
        : send(res, 400, { error: "empty body" });
    }
    send(res, 202, out);
  } catch (err) {
    console.error("ingest route failed:", err);
    send(res, 500, { error: "internal error" });
  }
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
    send(res, 404, { error: "not found" });
  });
}
