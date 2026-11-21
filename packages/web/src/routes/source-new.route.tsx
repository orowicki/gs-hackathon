import type { RouteDef } from "./types";
import { NewSourcePage } from "../pages/sources/SourcesPage";

export default {
  path: "/config/sources/new",
  element: <NewSourcePage />,
  crumb: "New source",
} satisfies RouteDef;
