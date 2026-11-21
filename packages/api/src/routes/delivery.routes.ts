import type { ChannelStatus, DeadLetter, Notification } from "@alerting/shared";
import { decodeSegment, send, type RouteModule } from "../http.js";

export interface DeliveryDeps {
  listDeadLetters(): Promise<DeadLetter[]>;
  retryDeadLetter(id: string): Promise<Notification | null>;
  channelStatus(): Promise<ChannelStatus[]>;
}

declare module "../http.js" {
  interface Deps {
    delivery?: DeliveryDeps;
  }
}

const RETRY = /^\/api\/dead-letters\/([^/]+)\/retry$/;

export default {
  name: "delivery",
  order: 20,
  async handle({ req, res, path, deps }) {
    const retry = req.method === "POST" ? RETRY.exec(path) : null;
    const isList = req.method === "GET" && path === "/api/dead-letters";
    const isChannels = req.method === "GET" && path === "/api/channels";
    if (!retry && !isList && !isChannels) return false;
    const delivery = deps.delivery;
    if (!delivery) {
      send(res, 503, { error: "delivery not configured" });
      return true;
    }
    if (isList) send(res, 200, await delivery.listDeadLetters());
    else if (isChannels) send(res, 200, await delivery.channelStatus());
    else {
      const id = decodeSegment(retry![1]!);
      if (id === undefined) send(res, 400, { error: "bad id" });
      else {
        const n = await delivery.retryDeadLetter(id);
        if (n) send(res, 200, n);
        else send(res, 404, { error: "dead letter not found" });
      }
    }
    return true;
  },
} satisfies RouteModule;
