import type { RouteDef } from "./types";
import { SchemaEditPage } from "../pages/schemas/SchemasPage";

export default {
  path: "/config/schemas/:id",
  element: <SchemaEditPage />,
  crumb: "Edit schema",
} satisfies RouteDef;
