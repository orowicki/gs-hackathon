import { Bot } from "lucide-react";
import type { RouteDef } from "./types";
import { ConnectClaudePage } from "../pages/claude/ConnectClaudePage";

export default {
  path: "/config/claude",
  element: <ConnectClaudePage />,
  nav: { section: "config", label: "Connect Claude", icon: Bot, order: 90 },
} satisfies RouteDef;
