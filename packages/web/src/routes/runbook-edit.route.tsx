import type { RouteDef } from "./types";
import { RunbookEditPage } from "../pages/runbooks/RunbooksPage";

export default {
  path: "/config/runbooks/:id",
  element: <RunbookEditPage />,
  crumb: "Edit runbook",
} satisfies RouteDef;
