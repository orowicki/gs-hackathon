import type { RouteDef } from "./types";
import { MyNotificationsPage } from "../pages/my-notifications/MyNotificationsPage";

export default {
  path: "/settings/notifications",
  element: <MyNotificationsPage />,
} satisfies RouteDef;
