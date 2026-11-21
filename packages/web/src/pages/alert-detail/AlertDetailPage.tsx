import { useEffect, useRef, useState } from "react";
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
  type RunbookRun,
} from "./api";
import { EventFields, FieldRow, ValueText } from "./EventFields";
import { formatDate, formatPrimitive, formatTimeValue, parseTimestamp } from "./format";

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
    <section aria-label="Runbooks">
      <h2>Runbooks</h2>
      {runs === null ? null : runs.length === 0 ? (
        <p className="muted">No runbook runs yet.</p>
      ) : (
        <ul className="plain">
          {runs.map((r, i) => (
            <li key={`${r.runbookId}-${i}`}>
              <span className="mono">{r.runbookId}</span>
              <ul className="plain nested-list">
                {(r.steps ?? []).map((s) => (
                  <li key={s.index} className="muted">
                    Step {s.index + 1}: {s.state}
                    {s.result ? ` — ${s.result}` : ""}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Audit({ entries }: { entries: AuditEntry[] | null }) {
  return (
    <section aria-label="Audit log">
      <h2>Audit log</h2>
      {entries === null ? null : entries.length === 0 ? (
        <p className="muted">No audit entries yet.</p>
      ) : (
        <ul className="plain">
          {entries.map((e, i) => {
            const d = parseTimestamp("at", e.at);
            return (
              <li key={`${e.id ?? ""}-${i}`}>
                <span className="muted">{d ? formatDate(d) : String(e.at ?? "—")}</span> {e.actor ?? "unknown"}{" "}
                {(e.action ?? "").replace(/_/g, " ")}
                {e.detail || e.result ? <span className="muted"> — {e.detail ?? e.result}</span> : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function AlertDetailPage() {
  const { id = "" } = useParams();
  const [alert, setAlert] = useState<Alert | null>(null);
  const [loadError, setLoadError] = useState<{ status: number; message: string } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [runs, setRuns] = useState<RunbookRun[] | null>(null);
  const [audit, setAudit] = useState<AuditEntry[] | null>(null);
  const isCurrent = useIsCurrent(id);

  useEffect(() => {
    let live = true;
    setAlert(null);
    setBusy(false);
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
  const title = str(alert.title) ?? str(common.title) ?? alert.id;
  const source = str(alert.source) ?? str(common.source);
  const environment = str(alert.environment) ?? str(common.environment);
  const dedupKey = str(alert.dedupKey) ?? str(common.dedupKey);
  const occurredAt = str(common.occurredAt);
  const message = str(common.message) ?? str(alert.body);
  const event = eventOf(alert);
  const first = when(alert.firstSeen);
  const last = when(alert.lastSeen);
  const header = [source, environment, first ? `first seen ${first}` : null, last ? `last seen ${last}` : null].filter(Boolean);

  const rows: Array<[string, string | undefined, boolean]> = [
    ["Title", title, false],
    ["Severity", SEVERITY_LABEL[severity] ?? severity.toUpperCase(), false],
    ["Source", source, false],
    ["Environment", environment, false],
    ["Source status", sourceStatusOf(alert), false],
    ["Type", str(common.type), true],
    ["Message", message, false],
    ["Entity", str(common.entity), false],
    ["Dedup key", dedupKey, true],
    ["Occurred at", when(occurredAt), false],
  ];

  return (
    <main className="page alert-detail">
      <BackLink />
      <header className={`alert-head sev-${severity}`}>
        <div className="title-line">
          <h1>{title}</h1>
          <span className="sev-count">
            {SEVERITY_LABEL[severity] ?? severity.toUpperCase()} · ×{alert.count ?? 1}
          </span>
        </div>
        <p className="muted small-text">{header.join(" · ")}</p>
      </header>

      <div className="actions" role="group" aria-label="Alert actions">
        <button type="button" className="btn" disabled={busy || state !== "open"} onClick={() => act(ackAlert)}>
          Acknowledge
        </button>
        <button type="button" className="btn" disabled={busy || state === "resolved"} onClick={() => act(resolveAlert)}>
          Resolve
        </button>
        <span className="muted small-text">
          State: <strong>{state}</strong>
        </span>
      </div>
      {actionError ? <p className="error-text" role="alert">{actionError}</p> : null}

      <section aria-label="Alert fields">
        <dl className="fields">
          {rows
            .filter(([, v]) => v !== undefined)
            .map(([label, v, mono]) => (
              <FieldRow key={label} label={label}>
                <ValueText display={{ text: v as string, mono, muted: false }} />
              </FieldRow>
            ))}
          <FieldRow label="Count">
            <ValueText display={formatPrimitive("count", alert.count ?? 1)} />
          </FieldRow>
          <FieldRow label="First seen">
            <ValueText display={{ text: first ?? "—", mono: false, muted: !first }} />
          </FieldRow>
          <FieldRow label="Last seen">
            <ValueText display={{ text: last ?? "—", mono: false, muted: !last }} />
          </FieldRow>
          <FieldRow label="State">
            <span data-testid="alert-state">
              <ValueText display={{ text: state, mono: false, muted: false }} />
            </span>
          </FieldRow>
        </dl>
      </section>

      {event ? (
        <EventFields event={event} />
      ) : (
        <section aria-label="Event data">
          <h2>Event</h2>
          <p className="muted">—</p>
        </section>
      )}

      <Runbooks runs={runs} />
      <Audit entries={audit} />
      <Suggest key={id} id={id} />
    </main>
  );
}
