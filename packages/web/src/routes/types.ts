import type { ReactNode } from "react";

/**
 * One route per `*.route.tsx` file. `order` defaults to 100; lower sorts first.
 * The "*" fallback uses the highest order so it is registered last.
 */
export interface RouteDef {
  path: string;
  element: ReactNode;
  order?: number;
}
