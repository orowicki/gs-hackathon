import type http from "node:http";
import { HttpIngestRegistry, handleHttpIngest } from "@alerting/ingest";
import { decodeSegment, send, type RouteModule } from "../http.js";

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

const INGEST = /^\/ingest\/([^/]+)$/;

export default {
  name: "ingest",
  order: 20,
  async handle({ req, res, path }) {
    const m = req.method === "POST" ? INGEST.exec(path) : null;
    if (!m) return false;
    const id = decodeSegment(m[1]!);
    if (id === undefined) send(res, 400, { error: "bad source id" });
    else await handleIngest(req, res, id);
    return true;
  },
} satisfies RouteModule;
