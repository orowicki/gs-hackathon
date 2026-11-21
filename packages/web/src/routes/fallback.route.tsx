import type { RouteDef } from "./types";
import { FeedPage } from "../pages/feed/FeedPage";

export default {
  path: "*",
  element: <FeedPage />,
  order: 1000,
} satisfies RouteDef;
