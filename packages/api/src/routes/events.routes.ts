import type { RouteModule } from "../http.js";
import { send } from "../http.js";
import { listEvents, type EventList } from "./events/list.js";
import { handleEventsRoutes, type EventsApiDeps } from "./events/http.js";

declare module "../http.js" {
  interface Deps {
    /** Recent events source; omitted = /api/events/recent and /test-filter 404. */
    recentEvents?: EventsApiDeps["recentEvents"];
    /** Stored events (GET /api/events); omitted = 503. */
    eventList?: EventList;
  }
}

export default {
  name: "events",
  order: 50,
  async handle({ req, res, path, url, deps }) {
    if (req.method === "GET" && path === "/api/events") {
      if (!deps.eventList) send(res, 503, { error: "events not configured" });
      else await listEvents(res, url, deps.eventList);
      return true;
    }
    const recentEvents = deps.recentEvents;
    if (!recentEvents) return false;
    if (path !== "/api/events/recent" && path !== "/api/events/test-filter") return false;
    return handleEventsRoutes(req, res, path, url, { recentEvents });
  },
} satisfies RouteModule;
