import { Users } from "lucide-react";
import type { RouteDef } from "./types";
import { PeoplePage } from "../pages/people/PeoplePage";

export default {
  path: "/config/people",
  element: <PeoplePage />,
  nav: { section: "config", label: "People & groups", icon: Users, order: 40 },
} satisfies RouteDef;
