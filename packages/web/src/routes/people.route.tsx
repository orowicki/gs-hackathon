import type { RouteDef } from "./types";
import { PeoplePage } from "../pages/people/PeoplePage";

export default {
  path: "/config/people",
  element: <PeoplePage />,
} satisfies RouteDef;
