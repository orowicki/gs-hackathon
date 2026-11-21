import type { RouteDef } from "./types";
import { SchemasListPage } from "../pages/schemas/SchemasPage";

export default {
  path: "/config/schemas",
  element: <SchemasListPage />,
} satisfies RouteDef;
