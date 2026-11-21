import type { RouteModule } from "../http.js";
import { handleStream } from "../stream/sse.js";

declare module "../http.js" {
  interface Deps {
    /** Subscribe to CHANNEL_UI_PUSH messages; returns an unsubscribe function. */
    subscribeUiPush?(onMessage: (json: string) => void): () => void;
    /** SSE heartbeat interval (ms), default 15000. */
    ssePingMs?: number;
    /** Max concurrent SSE clients (default 1000). */
    sseMaxConnections?: number;
  }
}

export default {
  name: "stream",
  order: 20,
  handle({ req, res, path, deps }) {
    if (req.method !== "GET" || path !== "/api/stream") return false;
    handleStream(req, res, deps.subscribeUiPush, deps.ssePingMs, deps.sseMaxConnections);
    return true;
  },
} satisfies RouteModule;
