import type { ConfigStore } from "@alerting/config";
import type { RouteModule } from "../http.js";
import { handleConfigRoute } from "./config/index.js";

declare module "../http.js" {
  interface Deps {
    /** Config store behind the config CRUD, preferences, YAML and filter routes. */
    config?: ConfigStore;
  }
}

export default {
  name: "config",
  // Before alerts (50, owns /api/rules/:id/suggestions, which this module never claims).
  order: 30,
  handle({ req, res, deps }) {
    return handleConfigRoute(req, res, deps);
  },
} satisfies RouteModule;
