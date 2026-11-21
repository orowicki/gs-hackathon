import { listSourcePlugins, PARSER_CONFIG_SCHEMA, registerBuiltinPlugins } from "@alerting/ingest";
import { send, type RouteModule } from "../http.js";

export default {
  name: "source-types",
  order: 20,
  async handle({ req, res, path }) {
    if (req.method !== "GET" || path !== "/api/source-types") return false;
    registerBuiltinPlugins(); // idempotent (Map keyed by type)
    const sourceTypes = listSourcePlugins().map((p) => ({ type: p.type, configSchema: p.configSchema }));
    send(res, 200, { sourceTypes, parserConfigSchema: PARSER_CONFIG_SCHEMA });
    return true;
  },
} satisfies RouteModule;
