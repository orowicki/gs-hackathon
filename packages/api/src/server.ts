import http from "node:http";
import { send, type Deps } from "./http.js";
import { routeModules } from "./routes/index.js";

// Routes live in src/routes/<name>.routes.ts (see http.ts: RouteModule). This file only
// dispatches; add a route by adding a file there, not by editing this one.
export type { Deps, RouteModule, RouteContext } from "./http.js";
export type { AlertsApiDeps } from "./routes/common.js";
export type { DeliveryDeps } from "./routes/delivery.routes.js";
export { MAX_INGEST_BYTES } from "./routes/ingest.routes.js";

export function createServer(deps: Deps): http.Server {
  const server = http.createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0]!;
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        for (const route of routeModules) {
          if (await route.handle({ req, res, path, url, deps })) return;
        }
        send(res, 404, { error: "not found" });
      } catch (err) {
        console.error("route failed:", err);
        if (!res.headersSent) send(res, 500, { error: "internal error" });
        else if (!res.writableEnded) res.end();
      }
    })();
  });
  server.requestTimeout = 30_000;
  return server;
}
