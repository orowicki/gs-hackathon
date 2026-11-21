import http from "node:http";
import { HttpIngestRegistry, handleHttpIngest } from "@alerting/ingest";
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
  server.requestTimeout = 30_000;
  return server;
}
