import type { Alert, Severity } from "@alerting/shared";

const PANELS: { sev: Severity; label: string }[] = [
  { sev: "critical", label: "Critical" },
  { sev: "error", label: "Error" },
  { sev: "warning", label: "Warning" },
  { sev: "info", label: "Info" },
];

/** Grafana-style stat panels: open (not yet acknowledged) alerts per severity. Clicking one filters the Active tab. */
export function StatPanels({ alerts, onFilter }: { alerts: Alert[]; onFilter: (q: string) => void }) {
  const open = alerts.filter((a) => a.state === "open");
  const count = (s: Severity) => open.filter((a) => a.severity === s).length;
  return (
    <section className="stats" aria-label="Open alerts by severity">
      <button type="button" className="stat" onClick={() => onFilter("")}>
        <span className="stat-label">Open alerts</span>
        <span className="stat-value">{open.length}</span>
      </button>
      {PANELS.map(({ sev, label }) => (
        <button
          key={sev}
          type="button"
          className={`stat sev-${sev}`}
          onClick={() => onFilter(`alert.severity = ${sev}`)}
        >
          <span className="stat-label">{label}</span>
          <span className="stat-value">{count(sev)}</span>
        </button>
      ))}
    </section>
  );
}
