// Fake demo service for runbook actions. Plain Node ESM, no dependencies.
import http from "node:http";
import { fileURLToPath } from "node:url";

export function startDemoService({ port = 0, host = "127.0.0.1" } = {}) {
  const calls = [];
  let healthy = true;

  const send = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const method = req.method ?? "GET";
      const path = new URL(req.url ?? "/", "http://x").pathname;
      const text = Buffer.concat(chunks).toString("utf8");
      let body = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (k === "content-type" || k.startsWith("x-")) headers[k] = Array.isArray(v) ? v.join(",") : v;
      }
      const isCallsQuery = method === "GET" && path === "/calls";
      if (!isCallsQuery) calls.push({ method, path, body, headers, at: new Date().toISOString() });

      let m;
      if (method === "GET" && path === "/health") {
        return healthy ? send(res, 200, { status: "ok" }) : send(res, 503, { status: "down" });
      }
      if (isCallsQuery) return send(res, 200, calls);
      if (method === "POST" && (m = path.match(/^\/workflows\/([^/]+)\/retry$/))) {
        return send(res, 200, { workflowId: decodeURIComponent(m[1]), status: "retried" });
      }
      if (method === "POST" && (m = path.match(/^\/restart\/([^/]+)$/))) {
        return send(res, 200, { instance: decodeURIComponent(m[1]), status: "restarted" });
      }
      send(res, 404, { error: "not found" });
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const p = typeof addr === "object" && addr ? addr.port : port;
      resolve({
        url: `http://${host}:${p}`,
        port: p,
        calls,
        reset() {
          calls.length = 0;
          healthy = true;
        },
        setHealthy(v) {
          healthy = Boolean(v);
        },
        close() {
          return new Promise((r) => {
            server.close(() => r());
            server.closeAllConnections?.();
          });
        },
      });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 4100);
  const svc = await startDemoService({ port, host: "0.0.0.0" });
  console.log(`demo-service listening on :${svc.port}`);
}
