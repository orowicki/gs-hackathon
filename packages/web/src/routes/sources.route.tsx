import type { RouteDef } from "./types";
import { SourcesListPage } from "../pages/sources/SourcesPage";

export default {
  path: "/config/sources",
  element: <SourcesListPage />,
} satisfies RouteDef;
