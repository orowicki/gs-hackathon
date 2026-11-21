import { parse } from "@alerting/ingest";
import { decodeSegment, send, type RouteModule } from "../http.js";
import { SSE_MAX_BUFFERED_BYTES, SSE_PING_MS } from "../stream/sse.js";
import type { PreviewDeps } from "./preview/types.js";

export { createRedisPreview, type RedisPreviewOptions } from "./preview/redis.js";
export type { PreviewDeps } from "./preview/types.js";

declare module "../http.js" {
  interface Deps {
    /** Live preview of a source's messages (GET /api/sources/{id}/preview). */
    preview?: PreviewDeps;
    /** Max concurrent preview streams (default 20). */
    previewMaxConnections?: number;
    /** Heartbeat interval for preview streams (ms), default 15000. */
    previewPingMs?: number;
  }
}

const PATH = /^\/api\/sources\/([^/]+)\/preview$/;
const MIN_PING_MS = 1000;
const activeByDeps = new WeakMap<object, { n: number }>();

export default {
  name: "preview",
  order: 10,
  async handle({ req, res, path, deps }) {
    const m = req.method === "GET" ? PATH.exec(path) : null;
    if (!m) return false;
    const preview = deps.preview;
    if (!preview) return send(res, 503, { error: "preview not configured" }), true;
    const id = decodeSegment(m[1]!);
    if (id === undefined) return send(res, 400, { error: "bad id" }), true;
    const source = await preview.getSource(id);
    if (!source) return send(res, 404, { error: "source not found" }), true;
    let counter = activeByDeps.get(deps);
    if (!counter) activeByDeps.set(deps, (counter = { n: 0 }));
    const slots = counter;
    if (slots.n >= (deps.previewMaxConnections ?? 20)) {
      return send(res, 503, { error: "too many preview streams" }), true;
    }
    slots.n++;
    const ac = new AbortController();
    let closed = false;
    const ping = setInterval(() => safeWrite(": ping\n\n"), Math.max(MIN_PING_MS, deps.previewPingMs ?? SSE_PING_MS));
    ping.unref();
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      slots.n--;
      clearInterval(ping);
      ac.abort();
    };
    const safeWrite = (chunk: string): void => {
      if (closed || res.destroyed || res.writableEnded) return;
      try {
        res.write(chunk);
        if (res.writableLength > SSE_MAX_BUFFERED_BYTES) {
          cleanup();
          res.destroy();
        }
      } catch {
        cleanup();
      }
    };
    req.on("close", cleanup);
    res.on("close", cleanup);
    res.on("error", cleanup);
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write("retry: 3000\n\n: connected\n\n");
    const onMessage = (msg: { receivedAt: string; raw: string }): void => {
      let parsed;
      try {
        parsed = parse(msg.raw, source.parser);
      } catch {
        parsed = { raw: msg.raw };
      }
      safeWrite(`data: ${JSON.stringify({ receivedAt: msg.receivedAt, raw: msg.raw, parsed })}\n\n`);
    };
    void (async () => {
      try {
        await preview.tail(id, onMessage, ac.signal);
      } catch (err) {
        // tail failed (e.g. Redis down): end the stream; the client reconnects via EventSource retry.
        console.error(`preview tail for source ${id} failed:`, (err as Error).message);
      } finally {
        cleanup();
        if (!res.writableEnded && !res.destroyed) res.end();
      }
    })();
    return true;
  },
} satisfies RouteModule;
