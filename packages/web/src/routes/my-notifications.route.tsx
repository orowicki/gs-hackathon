import type { RouteDef } from "./types";
import { MyNotificationsPage } from "../pages/my-notifications/MyNotificationsPage";

// Not in the sidebar: reached from the account menu (top right).
export default {
  path: "/settings/notifications",
  element: <MyNotificationsPage />,
  crumb: "Notification preferences",
} satisfies RouteDef;
