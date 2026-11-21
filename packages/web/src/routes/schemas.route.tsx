import { FileJson } from "lucide-react";
import type { RouteDef } from "./types";
import { SchemasListPage } from "../pages/schemas/SchemasPage";

export default {
  path: "/config/schemas",
  element: <SchemasListPage />,
  nav: { section: "config", label: "Schemas", icon: FileJson, order: 30 },
} satisfies RouteDef;
