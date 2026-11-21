import { ChevronRight, Siren } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link, matchPath, useLocation } from "react-router-dom";
import { routes } from "../routes/registry";
import type { NavEntry, RouteDef } from "../routes/types";
import { Icon } from "./Icon";
import { AccountMenu } from "./AccountMenu";
import { ThemeToggle } from "./ThemeSwitch";

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

/** Badge counts for nav entries with a countUrl (array length), polled every 10 s. */
function useNavCounts(items: NavRoute[]): Record<string, number> {
  const [counts, setCounts] = useState<Record<string, number>>({});
  const urls = items.map((r) => r.nav.countUrl).filter((u): u is string => Boolean(u));
  const key = urls.join("|");
  useEffect(() => {
    if (!key) return;
    let live = true;
    const tick = () =>
      key.split("|").forEach((u) =>
        fetch(u)
          .then((r) => (r.ok ? r.json() : null))
          .then((v) => live && Array.isArray(v) && setCounts((c) => ({ ...c, [u]: v.length })))
          .catch(() => undefined),
      );
    tick();
    const t = setInterval(tick, 10000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [key]);
  return counts;
}

/** Left sidebar (built from the route files' `nav` entries) + the page. */
export function AppShell({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const items = routes.filter((r): r is NavRoute => Boolean(r.nav));
  const counts = useNavCounts(items);
  const current = items.find((r) => isActive(r, pathname));
  const section = current && SECTIONS.find((s) => s.id === current.nav.section);
  const deeper = current && pathname !== current.path;
  // The page under the sidebar entry, if it names itself ("New rule", "Edit rule"...).
  // Most specific match wins: /rules/new over /rules/:id.
  const leaf = deeper
    ? routes
        .filter((r) => r.crumb && r.path !== "*" && matchPath({ path: r.path, end: true }, pathname))
        .sort((a, b) => a.path.split(":").length - b.path.split(":").length)[0]
    : undefined;
  // A page outside the sidebar (e.g. Notification preferences, from the account menu) names itself.
  const standalone = current
    ? undefined
    : routes.find((r) => r.crumb && r.path !== "*" && matchPath({ path: r.path, end: true }, pathname));
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
                    {r.nav.countUrl && (counts[r.nav.countUrl] ?? 0) > 0 && (
                      <span className="nav-badge" aria-label={`${counts[r.nav.countUrl]} waiting`}>
                        {counts[r.nav.countUrl]}
                      </span>
                    )}
                  </Link>
                );
              })}
          </div>
        ))}
      </nav>
      <div className="shell-main">
        <header className="app-bar">
          <nav className="crumbs" aria-label="Breadcrumb">
            {section && <span className="crumb">{section.title}</span>}
            {standalone && (
              <>
                <span className="crumb">Account</span>
                <Icon as={ChevronRight} />
                <span className="crumb current" aria-current="page">
                  {standalone.crumb}
                </span>
              </>
            )}
            {current && (
              <>
                <Icon as={ChevronRight} />
                {deeper ? (
                  <>
                    <Link className="crumb" to={current.path}>
                      {current.nav.label}
                    </Link>
                    {leaf?.crumb && (
                      <>
                        <Icon as={ChevronRight} />
                        <span className="crumb current" aria-current="page">
                          {leaf.crumb}
                        </span>
                      </>
                    )}
                  </>
                ) : (
                  <span className="crumb current" aria-current="page">
                    {current.nav.label}
                  </span>
                )}
              </>
            )}
          </nav>
          <div className="app-bar-actions">
            <ThemeToggle />
            <AccountMenu />
          </div>
        </header>
        <div className="shell-content">{children}</div>
      </div>
    </div>
  );
}
