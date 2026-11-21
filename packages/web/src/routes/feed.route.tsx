import { Bell } from "lucide-react";
import type { RouteDef } from "./types";
import { FeedPage } from "../pages/feed/FeedPage";

export default {
  path: "/",
  element: <FeedPage />,
  nav: { section: "alerts", label: "Alert feed", icon: Bell, order: 10, activeFor: ["/alerts"] },
} satisfies RouteDef;
