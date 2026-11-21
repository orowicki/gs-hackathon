import type { RouteModule } from "../http.js";
import { handleEventsRoutes, type EventsApiDeps } from "./events/http.js";

declare module "../http.js" {
  interface Deps {
    /** Recent events source; omitted = /api/events/recent and /test-filter 404. */
    recentEvents?: EventsApiDeps["recentEvents"];
  }
}

export default {
  name: "events",
  order: 50,
  handle({ req, res, path, url, deps }) {
    const recentEvents = deps.recentEvents;
    if (!recentEvents) return false;
    if (path !== "/api/events/recent" && path !== "/api/events/test-filter") return false;
    return handleEventsRoutes(req, res, path, url, { recentEvents });
  },
} satisfies RouteModule;
