import type { RouteDef } from "./types";
import { RuleEditorPage } from "../pages/rules/RuleEditorPage";

export default {
  path: "/rules/new",
  element: <RuleEditorPage />,
} satisfies RouteDef;
