import { Plug } from "lucide-react";
import type { RouteDef } from "./types";
import { SourcesListPage } from "../pages/sources/SourcesPage";

export default {
  path: "/config/sources",
  element: <SourcesListPage />,
  nav: { section: "config", label: "Sources", icon: Plug, order: 20 },
} satisfies RouteDef;
