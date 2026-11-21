import type { RouteDef } from "./types";
import { NewRulePage } from "../pages/rules/NewRulePage";

export default {
  path: "/rules/new",
  element: <NewRulePage />,
} satisfies RouteDef;
