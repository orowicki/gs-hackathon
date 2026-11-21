import type http from "node:http";

export const SSE_PING_MS = 15_000;

export interface UiPushHub {
  publish(json: string): void;
  subscribe(cb: (json: string) => void): () => void;
  readonly size: number;
}

export function createUiPushHub(): UiPushHub {
  const clients = new Set<(json: string) => void>();
  return {
    publish(json) {
      for (const cb of [...clients]) {
        try {
          cb(json);
        } catch {
          /* one failing client must not stop the others */
        }
      }
    },
    subscribe(cb) {
      clients.add(cb);
      return () => void clients.delete(cb);
    },
    get size() {
      return clients.size;
    },
  };
}

export function handleStream(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  subscribe: ((onMessage: (json: string) => void) => () => void) | undefined,
  pingMs: number = SSE_PING_MS,
): void {
  if (!subscribe) {
    const payload = JSON.stringify({ error: "delivery not configured" });
    res.writeHead(503, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
    res.end(payload);
    return;
  }
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  let closed = false;
  let unsubscribe: () => void = () => {};
  let ping: NodeJS.Timeout | undefined;
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    if (ping) clearInterval(ping);
    unsubscribe();
  };
  const safeWrite = (chunk: string): void => {
    if (closed || res.destroyed || res.writableEnded) return;
    try {
      res.write(chunk);
    } catch {
      cleanup();
    }
  };
  req.on("close", cleanup);
  res.on("close", cleanup);
  res.on("error", cleanup);
  res.write("retry: 3000\n\n: connected\n\n");
  unsubscribe = subscribe((json) => safeWrite(`data: ${json}\n\n`));
  if (closed) unsubscribe();
  else {
    ping = setInterval(() => safeWrite(": ping\n\n"), pingMs);
    ping.unref();
  }
}
