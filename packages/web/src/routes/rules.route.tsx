import { ListChecks } from "lucide-react";
import type { RouteDef } from "./types";
import { RulesListPage } from "../pages/rules/RulesListPage";

export default {
  path: "/rules",
  element: <RulesListPage />,
  nav: { section: "config", label: "Rules", icon: ListChecks, order: 10 },
} satisfies RouteDef;
