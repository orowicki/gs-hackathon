import { send, type RouteModule } from "../http.js";
import { buildOpenApi } from "../openapi.js";

export default {
  name: "openapi",
  order: 10,
  handle({ req, res, path }) {
    if (req.method !== "GET" || path !== "/api/openapi.json") return false;
    send(res, 200, buildOpenApi());
    return true;
  },
} satisfies RouteModule;
