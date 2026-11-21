import type { RouteModule } from "../http.js";
import type { createRunbookRoutes } from "@alerting/runbooks";

declare module "../http.js" {
  interface Deps {
    /** Runbook runs, approvals and audit routes (from @alerting/runbooks). */
    runbooks?: ReturnType<typeof createRunbookRoutes>;
  }
}

/**
 * Runs before the alerts routes (order 50) and the config CRUD: the runbooks handler
 * returns false for paths it does not own, so everything else falls through.
 */
export default {
  name: "runbooks",
  order: 40,
  async handle({ req, res, path, url, deps }) {
    if (!deps.runbooks) return false;
    if (!(path.startsWith("/api/alerts/") || path === "/api/approvals" || path === "/api/audit")) return false;
    return deps.runbooks.handle(req, res, url);
  },
} satisfies RouteModule;
