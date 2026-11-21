import type { RouteDef } from "./types";
import { NewSchemaPage } from "../pages/schemas/SchemasPage";

export default {
  path: "/config/schemas/new",
  element: <NewSchemaPage />,
  crumb: "New schema",
} satisfies RouteDef;
