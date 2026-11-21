import http from "node:http";

export interface Deps {
  checkPostgres(): Promise<boolean>;
  checkRedis(): Promise<boolean>;
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
    send(res, 404, { error: "not found" });
  });
}
