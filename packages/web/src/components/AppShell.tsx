import { Siren } from "lucide-react";
import type { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { routes } from "../routes/registry";
import type { NavEntry, RouteDef } from "../routes/types";
import { Icon } from "./Icon";

const SECTIONS: { id: NavEntry["section"]; title: string }[] = [
  { id: "alerts", title: "Alerts" },
  { id: "config", title: "Configuration" },
];

type NavRoute = RouteDef & { nav: NavEntry };

/** True when `pathname` is `base` or below it ("/" only matches itself). */
function under(pathname: string, base: string): boolean {
  if (base === "/") return pathname === "/";
  return pathname === base || pathname.startsWith(base + "/");
}

export function isActive(r: NavRoute, pathname: string): boolean {
  return [r.path, ...(r.nav.activeFor ?? [])].some((b) => under(pathname, b));
}

/** Left sidebar (built from the route files' `nav` entries) + the page. */
export function AppShell({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const items = routes.filter((r): r is NavRoute => Boolean(r.nav));
  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Main">
        <Link to="/" className="brand">
          <Icon as={Siren} />
          <span>Alerting</span>
        </Link>
        {SECTIONS.map((s) => (
          <div className="nav-section" key={s.id}>
            <div className="nav-title">{s.title}</div>
            {items
              .filter((r) => r.nav.section === s.id)
              .sort((a, b) => (a.nav.order ?? 100) - (b.nav.order ?? 100))
              .map((r) => {
                const active = isActive(r, pathname);
                return (
                  <Link
                    key={r.path}
                    to={r.path}
                    className={active ? "nav-item active" : "nav-item"}
                    aria-current={active ? "page" : undefined}
                  >
                    <Icon as={r.nav.icon} />
                    <span>{r.nav.label}</span>
                  </Link>
                );
              })}
          </div>
        ))}
      </nav>
      <div className="shell-main">{children}</div>
    </div>
  );
}
