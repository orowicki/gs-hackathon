import { BellRing } from "lucide-react";
import type { RouteDef } from "./types";
import { MyNotificationsPage } from "../pages/my-notifications/MyNotificationsPage";

export default {
  path: "/settings/notifications",
  element: <MyNotificationsPage />,
  nav: { section: "alerts", label: "My notifications", icon: BellRing, order: 20 },
} satisfies RouteDef;
