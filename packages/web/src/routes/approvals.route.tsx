import { ShieldCheck } from "lucide-react";
import type { RouteDef } from "./types";
import { APPROVALS_URL, ApprovalsPage } from "../pages/approvals/ApprovalsPage";

export default {
  path: "/approvals",
  element: <ApprovalsPage />,
  nav: { section: "alerts", label: "Approvals", icon: ShieldCheck, order: 12, countUrl: APPROVALS_URL },
} satisfies RouteDef;
