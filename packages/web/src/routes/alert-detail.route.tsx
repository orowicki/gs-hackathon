import type { RouteDef } from "./types";
import { AlertDetailPage } from "../pages/alert-detail/AlertDetailPage";

export default {
  path: "/alerts/:id",
  element: <AlertDetailPage />,
  crumb: "Alert",
} satisfies RouteDef;
