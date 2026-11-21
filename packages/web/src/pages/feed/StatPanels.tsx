import type { Alert, Severity } from "@alerting/shared";

const PANELS: { sev: Severity; label: string }[] = [
  { sev: "critical", label: "Critical" },
  { sev: "error", label: "Error" },
  { sev: "warning", label: "Warning" },
  { sev: "info", label: "Info" },
];

/** Grafana-style stat panels: open alerts per severity. Clicking one filters the feed. */
export function StatPanels({ alerts, onFilter }: { alerts: Alert[]; onFilter: (q: string) => void }) {
  const open = alerts.filter((a) => a.state !== "resolved");
  const count = (s: Severity) => open.filter((a) => a.severity === s).length;
  return (
    <section className="stats" aria-label="Open alerts by severity">
      <button type="button" className="stat" onClick={() => onFilter("alert.status != resolved")}>
        <span className="stat-label">Open alerts</span>
        <span className="stat-value">{open.length}</span>
      </button>
      {PANELS.map(({ sev, label }) => {
        const n = count(sev);
        return (
          <button
            key={sev}
            type="button"
            className={`stat sev-${sev}${n > 0 ? " lit" : ""}`}
            onClick={() => onFilter(`alert.severity = ${sev}`)}
          >
            <span className="stat-label">{label}</span>
            <span className="stat-value">{n}</span>
          </button>
        );
      })}
    </section>
  );
}
