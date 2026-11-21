// Fake demo service for runbook actions. Plain Node ESM, no dependencies.
// Open http://localhost:4100/ for a live page of every call the runbooks make, with switches that
// steer the runbooks' `if` branches (service down, retries failing, one region or all, latency high).
import http from "node:http";
import { fileURLToPath } from "node:url";
import { PAGE } from "./page.mjs";

const DEFAULTS = { healthy: true, retryFails: false, scope: "one-region", latencyHigh: false };

export function startDemoService({ port = 0, host = "127.0.0.1" } = {}) {
  const calls = [];
  const state = { ...DEFAULTS };

  const send = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", "http://x");
      const path = url.pathname;
      const text = Buffer.concat(chunks).toString("utf8");
      let body = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }

      // The page and its controls are not "calls".
      if (method === "GET" && path === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(PAGE);
      }
      if (path === "/favicon.ico") {
        res.writeHead(204);
        return res.end();
      }
      if (method === "GET" && path === "/calls") {
        const since = Number(url.searchParams.get("since") ?? 0);
        return send(res, 200, since > 0 ? calls.filter((c) => c.seq > since) : calls);
      }
      if (path === "/admin/state") {
        if (method === "POST" && body && typeof body === "object") {
          if (typeof body.healthy === "boolean") state.healthy = body.healthy;
          if (typeof body.retryFails === "boolean") state.retryFails = body.retryFails;
          if (body.scope === "one-region" || body.scope === "all-regions") state.scope = body.scope;
          if (typeof body.latencyHigh === "boolean") state.latencyHigh = body.latencyHigh;
        }
        return send(res, 200, state);
      }
      if (method === "POST" && path === "/admin/clear") {
        calls.length = 0;
        return send(res, 200, { cleared: true });
      }

      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (k === "content-type" || k.startsWith("x-")) headers[k] = Array.isArray(v) ? v.join(",") : v;
      }
      const call = { seq: (calls.at(-1)?.seq ?? 0) + 1, method, path, body, headers, at: new Date().toISOString() };
      calls.push(call);
      if (calls.length > 500) calls.splice(0, calls.length - 500);
      const reply = (status, out) => {
        call.status = status;
        call.response = out;
        send(res, status, out);
      };

      let m;
      if (method === "GET" && path === "/health") {
        return state.healthy ? reply(200, { status: "ok" }) : reply(503, { status: "down" });
      }
      if (method === "POST" && (m = path.match(/^\/workflows\/([^/]+)\/retry$/))) {
        const workflowId = decodeURIComponent(m[1]);
        return state.retryFails
          ? reply(500, { workflowId, status: "failed", error: "counterparty timed out again" })
          : reply(200, { workflowId, status: "retried" });
      }
      if (method === "POST" && (m = path.match(/^\/restart\/([^/]+)$/))) {
        return reply(200, { instance: decodeURIComponent(m[1]), status: "restarted" });
      }
      if (method === "GET" && (m = path.match(/^\/regions\/([^/]+)$/))) {
        const service = decodeURIComponent(m[1]);
        const one = state.scope === "one-region";
        return reply(200, {
          service,
          scope: state.scope,
          failing: one ? ["eu-west"] : ["eu-west", "us-east", "ap-south"],
          healthy: one ? ["us-east", "ap-south"] : [],
        });
      }
      if (method === "POST" && (m = path.match(/^\/failover\/([^/]+)$/))) {
        return reply(200, { service: decodeURIComponent(m[1]), from: body?.from ?? "eu-west", to: "us-east", status: "traffic moved" });
      }
      if (method === "POST" && (m = path.match(/^\/deployments\/([^/]+)\/rollback$/))) {
        return reply(200, { service: decodeURIComponent(m[1]), rolledBackTo: "v2026.11.20-3", status: "rolled back" });
      }
      if (method === "GET" && (m = path.match(/^\/latency\/([^/]+)$/))) {
        const ms = state.latencyHigh ? 1840 : 210;
        return reply(200, { instance: decodeURIComponent(m[1]), p99Ms: ms, high: ms > 1000 });
      }
      if (method === "POST" && (m = path.match(/^\/chat\/([^/]+)$/))) {
        return reply(200, { channel: `#${decodeURIComponent(m[1])}`, posted: true });
      }
      reply(404, { error: "not found" });
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
          Object.assign(state, DEFAULTS);
        },
        setHealthy(v) {
          state.healthy = Boolean(v);
        },
        setRetryFails(v) {
          state.retryFails = Boolean(v);
        },
        setScope(v) {
          state.scope = v === "all-regions" ? "all-regions" : "one-region";
        },
        setLatencyHigh(v) {
          state.latencyHigh = Boolean(v);
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
  console.log(`demo-service listening on :${svc.port} (live page at /)`);
}
