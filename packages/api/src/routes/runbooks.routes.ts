import type { RouteModule } from "../http.js";
import type { createRunbookRoutes } from "@alerting/runbooks";

declare module "../http.js" {
  interface Deps {
    /** Runbook runs, runs and approvals routes (audit is served by the alerts routes) (from @alerting/runbooks). */
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
    const owned =
      path === "/api/approvals" ||
      /^\/api\/alerts\/[^/]+\/runbook-runs$/.test(path) ||
      /^\/api\/alerts\/[^/]+\/runbooks$/.test(path) ||
      /^\/api\/alerts\/[^/]+\/runbook-steps\/[^/]+\/approve$/.test(path);
    if (!owned) return false;
    return deps.runbooks.handle(req, res, url);
  },
} satisfies RouteModule;
