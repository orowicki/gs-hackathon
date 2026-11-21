import { Check, ExternalLink, SkipForward, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAccount, useCurrentPerson } from "../../account";
import { Icon } from "../../components/Icon";
import { decideStep } from "../alert-detail/api";
import { relativeTime, severityLabel } from "../feed/helpers";
import "./approvals.css";

interface PendingApproval {
  alertId: string;
  runbookId: string;
  stepIndex: number;
  stepName: string;
  /** The approvers group the server enforces (from the run's runbook snapshot). */
  approvers?: string;
  requestedAt: string;
}
interface Step {
  name?: string;
  action?: string;
  group?: string;
  approval?: string;
  approvers?: string;
  url?: string;
  method?: string;
}
interface Runbook {
  id: string;
  name: string;
  steps?: Step[];
}
interface AlertLite {
  id: string;
  title: string;
  severity: "critical" | "error" | "warning" | "info";
  source?: string;
}
interface Group {
  id: string;
  name: string;
  memberIds?: string[];
}

async function get<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url);
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

/** What approving will make happen, in plain words. */
function describe(step: Step | undefined, groupName: (id?: string) => string): string {
  if (!step?.action) return "Runs the next step of the runbook.";
  switch (step.action) {
    case "escalate":
      return `Escalates the alert to ${groupName(step.group)}.`;
    case "http":
    case "webhook":
      return step.url ? `Calls ${step.method ?? "POST"} ${step.url}.` : "Calls an HTTP endpoint.";
    case "ticket":
      return "Opens a ticket.";
    case "retry":
      return "Retries the failed workflow.";
    case "restart":
      return "Restarts the service.";
    default:
      return `Runs the "${step.action}" action.`;
  }
}

/** Polled by the sidebar badge too. */
export const APPROVALS_URL = "/api/approvals";

/**
 * Alerts > Approvals (GET /api/approvals): every runbook step waiting for a person, across
 * open alerts (resolved ones drop out). Approve or skip right here; only members of the step's approvers
 * group can (the server enforces it).
 */
export function ApprovalsPage() {
  const me = useCurrentPerson();
  const { nameOf } = useAccount();
  const [items, setItems] = useState<PendingApproval[] | null>(null);
  const [error, setError] = useState("");
  const [alerts, setAlerts] = useState<Record<string, AlertLite | null>>({});
  const [runbooks, setRunbooks] = useState<Record<string, Runbook | null>>({});
  const [groups, setGroups] = useState<Group[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<{ key: string; text: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    const r = await fetch(APPROVALS_URL).catch(() => null);
    if (!r || !r.ok) return setError(r ? `HTTP ${r.status}` : "API not reachable");
    setError("");
    setItems((await r.json()) as PendingApproval[]);
    setNow(Date.now());
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    void get<Group[]>("/api/groups").then((g) => g && setGroups(g));
  }, []);

  // Load each alert and runbook once.
  useEffect(() => {
    for (const p of items ?? []) {
      if (!(p.alertId in alerts)) {
        setAlerts((a) => ({ ...a, [p.alertId]: null }));
        void get<AlertLite>(`/api/alerts/${encodeURIComponent(p.alertId)}`).then((x) => setAlerts((a) => ({ ...a, [p.alertId]: x })));
      }
      if (!(p.runbookId in runbooks)) {
        setRunbooks((r) => ({ ...r, [p.runbookId]: null }));
        void get<Runbook>(`/api/runbooks/${encodeURIComponent(p.runbookId)}`).then((x) => setRunbooks((r) => ({ ...r, [p.runbookId]: x })));
      }
    }
  }, [items, alerts, runbooks]);

  const groupName = (id?: string) => (id ? (groups.find((g) => g.id === id)?.name ?? id) : "the team");
  // Mirrors the server: signed in, and a member of the approvers group when the step has one
  // (an unknown group or groups that failed to load lock the buttons; the server would refuse anyway).
  const canApprove = (approvers?: string) => {
    if (!me) return false;
    if (!approvers) return true;
    const g = groups.find((x) => x.id === approvers);
    return !!g && (g.memberIds ?? []).includes(me.id);
  };

  async function decide(p: PendingApproval, decision: "approve" | "skip") {
    const key = `${p.alertId}:${p.runbookId}:${p.stepIndex}`;
    setBusy(key);
    try {
      await decideStep(p.alertId, p.runbookId, p.stepIndex, decision);
      setDone({ key, text: decision === "approve" ? `Approved "${p.stepName}". It is running now.` : `Skipped "${p.stepName}".` });
      await load();
    } catch (e) {
      setDone({ key, text: `Couldn't ${decision}: ${(e as Error).message}` });
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="page ap-page">
      <header className="page-header">
        <div>
          <h1>Approvals</h1>
          <p className="page-intro">
            Runbook steps that need a person before they run. Approving runs the step at once; skipping moves the runbook on without it. Each decision
            is recorded with your name.
          </p>
        </div>
      </header>

      {done && (
        <p className={done.text.startsWith("Couldn't") ? "callout error" : "callout info"} role="status">
          {done.text}
        </p>
      )}
      {error && (
        <p role="alert" className="callout error">
          Couldn't load approvals: {error}
        </p>
      )}
      {items === null && !error && <p className="muted">Loading approvals…</p>}
      {items?.length === 0 && (
        <div className="empty-state">
          <p>Nothing is waiting for approval.</p>
        </div>
      )}

      {items && items.length > 0 && (
        <ul className="ap-list" aria-label="Steps awaiting approval">
          {items.map((p) => {
            const key = `${p.alertId}:${p.runbookId}:${p.stepIndex}`;
            const alert = alerts[p.alertId];
            const rb = runbooks[p.runbookId];
            const step = rb?.steps?.[p.stepIndex];
            const approvers = p.approvers ?? step?.approvers;
            const allowed = canApprove(approvers);
            return (
              <li key={key} className="ap-card">
                <div className="ap-main">
                  <div className="ap-alert">
                    {alert && <span className={`sev-label sev-${alert.severity}`}>{severityLabel(alert.severity)}</span>}
                    <Link to={`/alerts/${encodeURIComponent(p.alertId)}`} className="ap-title">
                      {alert?.title ?? "Alert"}
                    </Link>
                    <span className="ap-when" title={new Date(p.requestedAt).toLocaleString()}>
                      waiting {relativeTime(p.requestedAt, now)}
                    </span>
                  </div>
                  <div className="ap-step">
                    <Icon as={ShieldCheck} />
                    <span>
                      <strong>{p.stepName}</strong>
                      <span className="muted">
                        {" "}
                        · step {p.stepIndex + 1} of {rb?.steps?.length ?? "?"} in {rb?.name ?? p.runbookId}
                      </span>
                    </span>
                  </div>
                  <p className="ap-what">{describe(step, groupName)}</p>
                  <p className="ap-who">
                    {approvers ? <>Approvers: {groupName(approvers)}</> : <>Anyone signed in can approve.</>}
                    {!me && <> · Sign in to decide</>}
                    {!allowed && me && <> · {nameOf(me.id)} isn't in this group</>}
                  </p>
                </div>
                <div className="ap-actions">
                  <button
                    type="button"
                    className="btn primary"
                    disabled={busy === key || !allowed}
                    title={allowed ? "Run this step now" : !me ? "Sign in to approve" : `Only ${groupName(approvers)} can approve`}
                    onClick={() => void decide(p, "approve")}
                  >
                    <Icon as={Check} /> Approve
                  </button>
                  <button type="button" className="btn" disabled={busy === key || !allowed} onClick={() => void decide(p, "skip")}>
                    <Icon as={SkipForward} /> Skip
                  </button>
                  <Link className="btn" to={`/alerts/${encodeURIComponent(p.alertId)}`}>
                    <Icon as={ExternalLink} /> Alert
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
