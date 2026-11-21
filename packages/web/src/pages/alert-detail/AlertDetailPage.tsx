import { BookOpen, CheckCircle2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "../../components/Icon";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import "./alert-detail.css";
import {
  ackAlert,
  ApiError,
  eventOf,
  getAlert,
  getAudit,
  getRunbookRuns,
  lifecycleOf,
  resolveAlert,
  sendSuggestion,
  sourceStatusOf,
  type Alert,
  type AuditEntry,
  type ResolveInput,
  type RulebookEntry,
  type RunbookRun,
} from "./api";
import { EventFields, ValueText } from "./EventFields";
import { formatDate, formatTimeValue, parseTimestamp } from "./format";

const SEVERITY_LABEL: Record<string, string> = { critical: "CRIT", error: "ERROR", warning: "WARN", info: "INFO" };

/** Tracks the id this component currently shows; false after the id changes or on unmount. */
function useIsCurrent(id: string): (forId: string) => boolean {
  const ref = useRef<string | null>(id);
  useEffect(() => {
    ref.current = id;
    return () => {
      ref.current = null;
    };
  }, [id]);
  return (forId) => ref.current === forId;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : typeof v === "number" ? String(v) : undefined;
}

function when(v: unknown): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  return formatTimeValue("at", v) ?? str(v);
}

function BackLink() {
  const navigate = useNavigate();
  const location = useLocation();
  const hasHistory = location.key !== "default";
  return (
    <Link
      to="/"
      onClick={(e) => {
        if (hasHistory) {
          e.preventDefault();
          navigate(-1);
        }
      }}
    >
      ← Back to alerts
    </Link>
  );
}

function Suggest({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);
  const isCurrent = useIsCurrent(id);

  if (!open) {
    return (
      <div className="suggest">
        <button type="button" className="link-btn" onClick={() => { setOpen(true); setState("idle"); }}>
          Suggest a change
        </button>
        {state === "sent" ? <span className="muted" role="status"> Suggestion sent</span> : null}
      </div>
    );
  }
  const send = async () => {
    setState("sending");
    setError(null);
    try {
      await sendSuggestion(id, text.trim());
      if (!isCurrent(id)) return;
      setText("");
      setOpen(false);
      setState("sent");
    } catch (e) {
      if (!isCurrent(id)) return;
      setError(e instanceof Error ? e.message : "Could not send suggestion.");
      setState("idle");
    }
  };
  return (
    <div className="suggest">
      <textarea
        aria-label="Suggestion"
        rows={3}
        value={text}
        placeholder="What should change about this alert or its rule?"
        onChange={(e) => setText(e.target.value)}
      />
      <div className="actions">
        <button type="button" className="btn primary" disabled={text.trim() === "" || state === "sending"} onClick={send}>
          Send
        </button>
        <button type="button" className="btn" onClick={() => { setOpen(false); setError(null); }}>
          Cancel
        </button>
      </div>
      {error ? <p className="error-text" role="alert">{error}</p> : null}
    </div>
  );
}

function Runbooks({ runs }: { runs: RunbookRun[] | null }) {
  return (
    <section aria-label="Runbooks" className="block">
      <h2>Runbooks</h2>
      {runs === null ? null : runs.length === 0 ? (
        <p className="muted">No runbook runs yet.</p>
      ) : (
        <ul className="plain">
          {runs.map((r, i) => (
            <li key={`${r.runbookId}-${i}`}>
              <span className="mono strong">{r.runbookId}</span>
              <ol className="steps">
                {(r.steps ?? []).map((s) => (
                  <li key={s.index} className={`step step-${s.state}`}>
                    <span className="step-state">{s.state}</span>
                    <span>Step {s.index + 1}</span>
                    {s.result ? <span className="muted"> — {s.result}</span> : null}
                  </li>
                ))}
              </ol>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Audit({ entries }: { entries: AuditEntry[] | null }) {
  return (
    <section aria-label="Audit log" className="block">
      <h2>Audit log</h2>
      {entries === null ? null : entries.length === 0 ? (
        <p className="muted">No audit entries yet.</p>
      ) : (
        <ol className="timeline">
          {entries.map((e, i) => {
            const d = parseTimestamp("at", e.at);
            return (
              <li key={`${e.id ?? ""}-${i}`} className={`tl-${e.action ?? ""}`}>
                <div className="tl-line">
                  <strong>{e.actor ?? "unknown"}</strong> <span>{(e.action ?? "").replace(/_/g, " ")}</span>
                  <span className="muted tl-time">{d ? formatDate(d) : String(e.at ?? "—")}</span>
                </div>
                {e.detail || e.result ? <div className="tl-detail">{e.detail ?? e.result}</div> : null}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

/** The rule's "how to resolve" text from the rulebook. */
function RulebookCard({ entry }: { entry: RulebookEntry }) {
  const d = parseTimestamp("at", entry.updatedAt);
  return (
    <section aria-label="How to resolve" className="card rulebook-card">
      <h2>
        <Icon as={BookOpen} /> How to resolve
      </h2>
      <p className="prose">{entry.text}</p>
      <p className="muted small-text">
        Written by {entry.updatedBy}
        {d ? ` on ${formatDate(d)}` : ""}
      </p>
    </section>
  );
}

function ResolutionCard({ alert }: { alert: Alert }) {
  const d = parseTimestamp("at", alert.resolvedAt);
  return (
    <section aria-label="Resolution" className="card resolution-card">
      <h2>
        <Icon as={CheckCircle2} /> Resolved
      </h2>
      {alert.resolution ? <p className="prose">{alert.resolution}</p> : <p className="muted">No resolution note.</p>}
      {alert.resolvedBy || d ? (
        <p className="muted small-text">
          Resolved{alert.resolvedBy ? ` by ${alert.resolvedBy}` : ""}
          {d ? ` on ${formatDate(d)}` : ""}
        </p>
      ) : null}
    </section>
  );
}

/** Resolve form: a note on how it was fixed, optionally saved to the rule's rulebook. */
function ResolvePanel({
  alert,
  busy,
  onCancel,
  onResolve,
}: {
  alert: Alert;
  busy: boolean;
  onCancel(): void;
  onResolve(input: ResolveInput): void;
}) {
  const existing = alert.rulebook?.text ?? "";
  const [text, setText] = useState(existing);
  const [contribute, setContribute] = useState(false);
  const trimmed = text.trim();
  const changed = trimmed !== existing.trim();
  return (
    <section aria-label="Resolve alert" className="card resolve-panel">
      <h2>Resolve this alert</h2>
      <label className="field-label" htmlFor="resolution">
        How was it resolved?
      </label>
      <textarea
        id="resolution"
        rows={5}
        value={text}
        placeholder="What did you do to fix it? Steps, commands, who to contact…"
        onChange={(e) => setText(e.target.value)}
      />
      {existing ? (
        <p className="muted small-text">Filled in from the rulebook. Change it to say what you actually did.</p>
      ) : null}
      <label className="check">
        <input type="checkbox" checked={contribute} disabled={trimmed === ""} onChange={(e) => setContribute(e.target.checked)} />
        <span className="check-text">
          <strong>Save to the rulebook</strong>
          <span className="muted">
            Every alert from rule <span className="mono">{alert.ruleId ?? "this rule"}</span> will show this text under
            How to resolve.
            {existing && changed ? " It replaces the current text." : ""}
          </span>
        </span>
      </label>
      <div className="actions">
        <button
          type="button"
          className="btn primary solid"
          disabled={busy}
          onClick={() => onResolve({ resolution: trimmed || undefined, contribute: contribute && trimmed !== "" })}
        >
          Resolve
        </button>
        <button type="button" className="btn" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}

function Fact({ label, children, wide = false }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={wide ? "fact-tile wide" : "fact-tile"}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function AlertDetailPage() {
  const { id = "" } = useParams();
  const [alert, setAlert] = useState<Alert | null>(null);
  const [loadError, setLoadError] = useState<{ status: number; message: string } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [runs, setRuns] = useState<RunbookRun[] | null>(null);
  const [audit, setAudit] = useState<AuditEntry[] | null>(null);
  const isCurrent = useIsCurrent(id);

  useEffect(() => {
    let live = true;
    setAlert(null);
    setBusy(false);
    setResolving(false);
    setActionError(null);
    setLoadError(null);
    setRuns(null);
    setAudit(null);
    getAlert(id)
      .then((a) => live && setAlert(a))
      .catch((e: unknown) => {
        if (!live) return;
        setLoadError(
          e instanceof ApiError ? { status: e.status, message: e.message } : { status: 0, message: "Could not load alert." },
        );
      });
    void getRunbookRuns(id).then((r) => live && setRuns(r));
    void getAudit(id).then((r) => live && setAudit(r));
    return () => {
      live = false;
    };
  }, [id]);

  const act = async (fn: (id: string) => Promise<Alert>) => {
    setBusy(true);
    setActionError(null);
    try {
      const updated = await fn(id);
      if (!isCurrent(id)) return;
      setAlert((prev) => ({ ...(prev ?? {}), ...updated }));
      setResolving(false);
      void getAudit(id).then((a) => isCurrent(id) && setAudit(a));
    } catch (e) {
      if (!isCurrent(id)) return;
      setActionError(e instanceof Error ? e.message : "Action failed.");
    } finally {
      if (isCurrent(id)) setBusy(false);
    }
  };

  if (loadError) {
    return (
      <main className="page alert-detail">
        <BackLink />
        <p className="muted" role="alert">
          {loadError.status === 404 ? "Alert not found." : loadError.message}
        </p>
      </main>
    );
  }
  if (!alert) {
    return (
      <main className="page alert-detail">
        <BackLink />
        <p className="muted">Loading…</p>
      </main>
    );
  }

  const common = alert.common ?? {};
  const state = lifecycleOf(alert);
  const severity = str(alert.severity) ?? str(common.severity) ?? "info";
  const sevLabel = SEVERITY_LABEL[severity] ?? severity.toUpperCase();
  const title = str(alert.title) ?? str(common.title) ?? alert.id;
  const source = str(alert.source) ?? str(common.source);
  const environment = str(alert.environment) ?? str(common.environment);
  const dedupKey = str(alert.dedupKey) ?? str(common.dedupKey);
  const occurredAt = str(common.occurredAt);
  const message = str(common.message) ?? str(alert.body);
  const event = eventOf(alert);
  const first = when(alert.firstSeen);
  const last = when(alert.lastSeen);
  const sourceStatus = sourceStatusOf(alert);
  const ackWho = str(alert.acknowledgedBy);
  const ackAt = when(alert.acknowledgedAt);

  const facts: Array<[string, string | undefined, boolean]> = [
    ["Source", source, false],
    ["Environment", environment, false],
    ["Source status", sourceStatus, false],
    ["Type", str(common.type), true],
    ["Entity", str(common.entity), false],
    ["Rule", str(alert.ruleId), true],
    ["Dedup key", dedupKey, true],
    ["Occurred at", when(occurredAt), false],
    ["First seen", first, false],
    ["Last seen", last, false],
  ];
  const ruleFields = (alert.fields ?? []).filter((f) => f && f.label && f.value !== undefined);

  return (
    <main className="page alert-detail">
      <BackLink />
      <header className={`alert-head sev-${severity}`}>
        <div className="head-main">
          <div className="badges">
            <span className={`sev-badge sev-${severity}`}>{sevLabel}</span>
            <span className={`state-pill state-${state}`} data-testid="alert-state">
              {state}
            </span>
            {(alert.count ?? 1) > 1 ? <span className="count-pill">×{alert.count} occurrences</span> : null}
          </div>
          <h1>{title}</h1>
          <p className="head-meta">
            {source ?? "Unknown source"}
            {environment ? <> in <strong>{environment}</strong></> : null}
            {last ? <span className="muted">, last seen {last}</span> : null}
          </p>
          {state === "acknowledged" && (ackWho || ackAt) ? (
            <p className="muted small-text">
              Acknowledged{ackWho ? ` by ${ackWho}` : ""}
              {ackAt ? `, ${ackAt}` : ""}
            </p>
          ) : null}
        </div>
        <div className="actions head-actions" role="group" aria-label="Alert actions">
          <button type="button" className="btn" disabled={busy || state !== "open"} onClick={() => act(ackAlert)}>
            Acknowledge
          </button>
          <button
            type="button"
            className="btn primary solid"
            disabled={busy || state === "resolved" || resolving}
            onClick={() => setResolving(true)}
          >
            Resolve…
          </button>
        </div>
      </header>
      {actionError ? <p className="error-text" role="alert">{actionError}</p> : null}

      {resolving && state !== "resolved" ? (
        <ResolvePanel
          alert={alert}
          busy={busy}
          onCancel={() => setResolving(false)}
          onResolve={(input) => act((x) => resolveAlert(x, input))}
        />
      ) : null}

      {state === "resolved" ? <ResolutionCard alert={alert} /> : null}
      {alert.rulebook && !resolving ? <RulebookCard entry={alert.rulebook} /> : null}

      {message ? (
        <section aria-label="Message" className="block">
          <h2>Message</h2>
          <p className="prose">{message}</p>
        </section>
      ) : null}

      <section aria-label="Alert fields" className="block">
        <h2>Details</h2>
        <dl className="fact-grid">
          {facts
            .filter(([, v]) => v !== undefined)
            .map(([label, v, mono]) => (
              <Fact key={label} label={label}>
                <ValueText display={{ text: v as string, mono, muted: false }} />
              </Fact>
            ))}
          {ruleFields.map((f, i) => (
            <Fact key={`rf-${i}`} label={f.label}>
              <ValueText display={{ text: String(f.value), mono: false, muted: false }} />
            </Fact>
          ))}
        </dl>
      </section>

      {event ? (
        <EventFields event={event} />
      ) : (
        <section aria-label="Event data" className="block">
          <h2>Event</h2>
          <p className="muted">—</p>
        </section>
      )}

      <div className="two-col">
        <Runbooks runs={runs} />
        <Audit entries={audit} />
      </div>
      <Suggest key={id} id={id} />
    </main>
  );
}
