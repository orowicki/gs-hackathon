import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { Rule } from "@alerting/shared";
import { listRules } from "./api";
import { filterText, shortText } from "./helpers";
import "./rules.css";

function recipientCount(r: Rule): number {
  return new Set(r.who.flatMap((w) => w.recipients.map((x) => `${x.type}:${x.id}`))).size;
}

export function RulesListPage() {
  const navigate = useNavigate();
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    listRules().then(
      (r) => live && setRules(r),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, []);

  return (
    <main className="page rules-page">
      <header className="page-header">
        <div>
          <h1>Rules</h1>
          <p className="page-intro">Rules turn matching events into alerts and decide who gets notified.</p>
        </div>
        <div className="page-actions">
          <Link className="btn" to="/rules/new?mode=yaml">
            Import YAML
          </Link>
          <Link className="btn primary" to="/rules/new">
            <Plus size={14} aria-hidden="true" />
            New rule
          </Link>
        </div>
      </header>
      {error && (
        <p role="alert" className="callout error">
          Couldn't load rules: {error}
        </p>
      )}
      {rules === null && !error && <p className="muted">Loading rules…</p>}
      {rules?.length === 0 && (
        <div className="empty-state">
          <p>No rules yet. Without a rule, events are stored but never become alerts.</p>
          <Link className="btn primary" to="/rules/new">
            Create the first rule
          </Link>
        </div>
      )}
      {rules && rules.length > 0 && (
        <table className="rules-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Fires when</th>
              <th>Notifies</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => {
              const n = recipientCount(r);
              const href = "/rules/" + encodeURIComponent(r.id);
              return (
                <tr key={r.id} className="clickable" onClick={() => navigate(href)}>
                  <td>
                    <Link to={href} onClick={(e) => e.stopPropagation()}>
                      {r.name}
                    </Link>
                  </td>
                  <td>
                    <code className="cond">{shortText(filterText(r.when), 80) || "every event"}</code>
                  </td>
                  <td className="muted">{n === 0 ? "nobody" : n === 1 ? "1 recipient" : `${n} recipients`}</td>
                  <td>
                    <span className={r.enabled ? "tag ok" : "tag"}>{r.enabled ? "Enabled" : "Disabled"}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </main>
  );
}
