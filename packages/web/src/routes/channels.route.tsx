import type { RouteDef } from "./types";
import { ChannelsPage } from "../pages/channels/ChannelsPage";

export default {
  path: "/config/channels",
  element: <ChannelsPage />,
} satisfies RouteDef;
