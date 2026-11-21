import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/** A sidebar entry. "alerts" = the screen for people handling alerts; "config" = setting it up. */
export interface NavEntry {
  section: "alerts" | "config";
  label: string;
  icon: LucideIcon;
  /** Lower sorts first within the section; default 100. */
  order?: number;
  /** Extra path prefixes that also mark this entry active (e.g. "/alerts" for the feed). */
  activeFor?: string[];
  /** GET URL returning a JSON array: its length shows as a badge (polled every 10 s). */
  countUrl?: string;
}

/**
 * One route per `*.route.tsx` file. `order` defaults to 100; lower sorts first.
 * The "*" fallback uses the highest order so it is registered last.
 * Add `nav` to show the page in the sidebar.
 */
export interface RouteDef {
  path: string;
  element: ReactNode;
  order?: number;
  nav?: NavEntry;
  /** Last breadcrumb for a page that isn't in the sidebar ("New rule" under Rules). */
  crumb?: string;
}
