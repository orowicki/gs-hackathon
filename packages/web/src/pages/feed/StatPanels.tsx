import type { Alert, Severity } from "@alerting/shared";

const PANELS: { sev: Severity; label: string }[] = [
  { sev: "critical", label: "Critical" },
  { sev: "error", label: "Error" },
  { sev: "warning", label: "Warning" },
  { sev: "info", label: "Info" },
];

const OPEN_FILTER = "alert.status != resolved";
const sevFilter = (s: Severity) => `alert.severity = ${s}`;
const norm = (q: string) => q.trim().replace(/\s+/g, " ");

/**
 * Grafana-style stat panels: open alerts per severity. Clicking a panel filters the feed;
 * clicking the selected panel again clears the filter. The panel matching the current
 * filter is marked selected and the others step back.
 */
export function StatPanels({
  alerts,
  filter,
  onFilter,
}: {
  alerts: Alert[];
  filter: string;
  onFilter: (q: string) => void;
}) {
  const open = alerts.filter((a) => a.state !== "resolved");
  const count = (s: Severity) => open.filter((a) => a.severity === s).length;
  const current = norm(filter);
  const filtering = current !== "";
  const panel = (key: string, q: string, label: string, n: number, extra = "") => {
    const selected = current === q;
    const cls = ["stat", extra, selected ? "selected" : "", filtering && !selected ? "dimmed" : ""]
      .filter(Boolean)
      .join(" ");
    return (
      <button key={key} type="button" className={cls} aria-pressed={selected} onClick={() => onFilter(selected ? "" : q)}>
        <span className="stat-label">{label}</span>
        <span className="stat-value">{n}</span>
      </button>
    );
  };
  return (
    <section className="stats" aria-label="Open alerts by severity">
      {panel("open", OPEN_FILTER, "Open alerts", open.length)}
      {PANELS.map(({ sev, label }) => {
        const n = count(sev);
        return panel(sev, sevFilter(sev), label, n, `sev-${sev}${n > 0 ? " lit" : ""}`);
      })}
    </section>
  );
}
