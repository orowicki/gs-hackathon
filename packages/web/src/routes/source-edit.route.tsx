import type { RouteDef } from "./types";
import { SourceEditPage } from "../pages/sources/SourcesPage";

export default {
  path: "/config/sources/:id",
  element: <SourceEditPage />,
  crumb: "Edit source",
} satisfies RouteDef;
