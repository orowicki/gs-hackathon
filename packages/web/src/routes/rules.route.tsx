import type { RouteDef } from "./types";
import { RulesListPage } from "../pages/rules/RulesListPage";

export default {
  path: "/rules",
  element: <RulesListPage />,
} satisfies RouteDef;
