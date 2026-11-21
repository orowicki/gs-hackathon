import { Send } from "lucide-react";
import type { RouteDef } from "./types";
import { ChannelsPage } from "../pages/channels/ChannelsPage";

export default {
  path: "/config/channels",
  element: <ChannelsPage />,
  nav: { section: "config", label: "Channels", icon: Send, order: 50 },
} satisfies RouteDef;
