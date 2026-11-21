import { Activity } from "lucide-react";
import type { RouteDef } from "./types";
import { EventsPage } from "../pages/events/EventsPage";

export default {
  path: "/events",
  element: <EventsPage />,
  nav: { section: "alerts", label: "Events", icon: Activity, order: 15 },
} satisfies RouteDef;
