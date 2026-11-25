import { send, type RouteModule } from "../http.js";
import { rankingData } from "./ranking/data.js";
import { SCORE_FORMULA, rankEntries, renderPage } from "./ranking/page.js";

export default {
  name: "ranking",
  order: 50,
  handle({ req, res, path }) {
    const head = req.method === "HEAD";
    if (req.method !== "GET" && !head) return false;
    if (path === "/api/ranking") {
      send(res, 200, { ...rankingData, formula: SCORE_FORMULA, ranking: rankEntries(rankingData) });
      return true;
    }
    if (path !== "/ranking") return false;
    const html = renderPage(rankingData);
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": Buffer.byteLength(html),
      "cache-control": "no-cache",
    });
    res.end(head ? undefined : html);
    return true;
  },
} satisfies RouteModule;
