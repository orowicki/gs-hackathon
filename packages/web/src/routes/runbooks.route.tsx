import { BookOpenCheck } from "lucide-react";
import type { RouteDef } from "./types";
import { RunbooksListPage } from "../pages/runbooks/RunbooksPage";

export default {
  path: "/config/runbooks",
  element: <RunbooksListPage />,
  nav: { section: "config", label: "Runbooks", icon: BookOpenCheck, order: 15 },
} satisfies RouteDef;
