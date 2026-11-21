import type { RouteDef } from "./types";
import { NewRunbookPage } from "../pages/runbooks/RunbooksPage";

export default {
  path: "/config/runbooks/new",
  element: <NewRunbookPage />,
  crumb: "New runbook",
} satisfies RouteDef;
