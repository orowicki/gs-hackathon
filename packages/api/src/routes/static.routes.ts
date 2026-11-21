import type { RouteModule } from "../http.js";
import { serveStatic } from "../static.js";

declare module "../http.js" {
  interface Deps {
    /** Directory with the built web app; defaults to env WEB_DIST. */
    webDist?: string;
  }
}

// Catch-all for the web app: runs after every other route.
export default {
  name: "static",
  order: 1000,
  handle({ req, res, path, deps }) {
    const webDist = deps.webDist ?? process.env.WEB_DIST;
    if (!webDist || (req.method !== "GET" && req.method !== "HEAD")) return false;
    if (path === "/api" || path.startsWith("/api/")) return false;
    return serveStatic(req, res, webDist);
  },
} satisfies RouteModule;
