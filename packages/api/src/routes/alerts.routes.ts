import type { RouteModule } from "../http.js";
import type { AlertsApiDeps } from "./common.js";
import { handleAlertsRoutes } from "./alerts/http.js";
import { handleSuggestionsRoutes } from "./suggestions/http.js";

declare module "../http.js" {
  interface Deps {
    /** Alerts, audit and suggestions routes; omitted = those paths 404. */
    alerts?: AlertsApiDeps;
  }
}

export default {
  name: "alerts",
  order: 50,
  async handle({ req, res, path, url, deps }) {
    const alerts = deps.alerts;
    if (!alerts) return false;
    if (await handleAlertsRoutes(req, res, path, url, alerts)) return true;
    return handleSuggestionsRoutes(req, res, path, url, alerts);
  },
} satisfies RouteModule;
