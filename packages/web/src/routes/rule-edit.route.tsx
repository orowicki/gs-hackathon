import type { RouteDef } from "./types";
import { RuleEditorPage } from "../pages/rules/RuleEditorPage";

export default {
  path: "/rules/:id",
  element: <RuleEditorPage />,
} satisfies RouteDef;
