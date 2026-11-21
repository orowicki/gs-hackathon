import { BookOpen, Check, CheckCircle2, FileCode2, Lock, MessageSquare, Undo2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "../../components/Icon";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import "./alert-detail.css";
import {
  ackAlert,
  addRulebookComment,
  getRuleRunbook,
  putRuleRunbook,
  type RuleRunbook,
  ApiError,
  eventOf,
  getAlert,
  getAudit,
  getRunbookRuns,
  lifecycleOf,
  resolveAlert,
  sendSuggestion,
  sourceStatusOf,
  unackAlert,
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
    <section aria-label="Runbooks" className="ad-panel">
      <div className="panel-head"><h2>Runbooks</h2></div>
      <div className="panel-body">
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
      </div>
    </section>
  );
}

function Audit({ entries }: { entries: AuditEntry[] | null }) {
  return (
    <section aria-label="Audit log" className="ad-panel">
      <div className="panel-head"><h2>Audit log</h2></div>
      <div className="panel-body">
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
      </div>
    </section>
  );
}

/** "How to resolve": the rule's comment thread, shown on every alert of the rule. */
function RulebookThread({
  alertId,
  ruleId,
  entries,
  onAdded,
}: {
  alertId: string;
  ruleId?: string;
  entries: RulebookEntry[];
  onAdded(e: RulebookEntry): void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isCurrent = useIsCurrent(alertId);
  const post = async () => {
    setBusy(true);
    setError(null);
    try {
      const e = await addRulebookComment(alertId, text.trim());
      if (!isCurrent(alertId)) return;
      onAdded(e);
      setText("");
    } catch (err) {
      if (isCurrent(alertId)) setError(err instanceof Error ? err.message : "Could not post the comment.");
    } finally {
      if (isCurrent(alertId)) setBusy(false);
    }
  };
  return (
    <section aria-label="How to resolve" className="ad-panel">
      <div className="panel-head">
        <h2>
          <Icon as={BookOpen} /> How to resolve
          <span className="count-chip">{entries.length}</span>
        </h2>
        <span className="muted small-text">
          Shared by every alert of rule <span className="mono">{ruleId ?? "—"}</span>
        </span>
      </div>
      <div className="panel-body">
        {entries.length === 0 ? (
          <p className="muted empty-note">
            <Icon as={MessageSquare} /> No one has written how to resolve this yet.
          </p>
        ) : (
          <ol className="comments">
            {entries.map((e) => {
              const d = parseTimestamp("at", e.updatedAt);
              return (
                <li key={e.id} className="comment">
                  <span className="avatar" aria-hidden="true">
                    {(e.updatedBy || "?").charAt(0).toUpperCase()}
                  </span>
                  <div className="comment-main">
                    <div className="comment-meta">
                      <strong>{e.updatedBy}</strong>
                      {d ? <span className="muted">{formatDate(d)}</span> : null}
                      {e.alertId && e.alertId !== alertId ? (
                        <Link className="muted" to={`/alerts/${encodeURIComponent(e.alertId)}`}>
                          from another alert
                        </Link>
                      ) : e.alertId === alertId ? (
                        <span className="muted">on this alert</span>
                      ) : null}
                    </div>
                    <p className="prose">{e.text}</p>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
        <div className="comment-form">
          <textarea
            aria-label="Add a how-to-resolve comment"
            rows={3}
            value={text}
            placeholder="Add how you resolve this: steps, commands, who to contact…"
            onChange={(e) => setText(e.target.value)}
          />
          <div className="actions">
            <button type="button" className="btn primary solid" disabled={busy || text.trim() === ""} onClick={post}>
              Comment
            </button>
          </div>
          {error ? <p className="error-text" role="alert">{error}</p> : null}
        </div>
      </div>
    </section>
  );
}

const RUNBOOK_TEMPLATE = `# One runbook per rule. Saving replaces it. Applies to new alerts of this rule.
name: How to fix this
type: text            # text = instructions, automation = steps the worker runs
content: |
  1. Check the service dashboard.
  2. Restart the instance named in the alert ({{alert.entity}}).
# For automation, drop content and add steps (actions: http, escalate, wait):
# type: automation
# steps:
#   - name: Check health
#     action: http
#     method: GET
#     url: http://service/health
#   - name: Escalate
#     action: escalate
#     group: settlements-oncall
#     approval: required
`;

/** The rule's own runbook, written as YAML. One per rule; saving overwrites it. */
function RuleRunbookPanel({ ruleId }: { ruleId: string }) {
  const [current, setCurrent] = useState<RuleRunbook | null | undefined>(undefined);
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showYaml, setShowYaml] = useState(false);
  const isCurrent = useIsCurrent(ruleId);

  useEffect(() => {
    let live = true;
    setCurrent(undefined);
    setDraft(null);
    setError(null);
    getRuleRunbook(ruleId)
      .then((r) => live && setCurrent(r))
      .catch(() => live && setCurrent(null));
    return () => {
      live = false;
    };
  }, [ruleId]);

  const save = async () => {
    if (draft === null) return;
    setBusy(true);
    setError(null);
    try {
      const r = await putRuleRunbook(ruleId, draft);
      if (!isCurrent(ruleId)) return;
      setCurrent(r);
      setDraft(null);
    } catch (e) {
      if (isCurrent(ruleId)) setError(e instanceof Error ? e.message : "Could not save the runbook.");
    } finally {
      if (isCurrent(ruleId)) setBusy(false);
    }
  };

  const rb = current?.runbook;
  return (
    <section aria-label="Rule runbook" className="ad-panel">
      <div className="panel-head">
        <h2>
          <Icon as={FileCode2} /> Rule runbook
          {rb ? <span className={`type-chip type-${rb.type}`}>{rb.type}</span> : null}
        </h2>
        {draft === null && current !== undefined ? (
          <button type="button" className="btn" onClick={() => setDraft(current?.yaml ?? RUNBOOK_TEMPLATE)}>
            {rb ? "Edit YAML" : "Write runbook"}
          </button>
        ) : null}
      </div>
      <div className="panel-body stack">
        {draft !== null ? (
          <>
            <textarea
              aria-label="Runbook YAML"
              className="mono yaml-editor"
              rows={16}
              spellCheck={false}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <p className="muted small-text">
              {rb ? "Saving replaces the current runbook. " : ""}It runs on new alerts of this rule; the matching is set for
              you.
            </p>
            {error ? <p className="error-text" role="alert">{error}</p> : null}
            <div className="actions">
              <button type="button" className="btn primary solid" disabled={busy || draft.trim() === ""} onClick={save}>
                {rb ? "Save and replace" : "Save runbook"}
              </button>
              <button type="button" className="btn" disabled={busy} onClick={() => { setDraft(null); setError(null); }}>
                Cancel
              </button>
            </div>
          </>
        ) : current === undefined ? (
          <p className="muted">Loading…</p>
        ) : !rb ? (
          <p className="muted empty-note">This rule has no runbook. Write one in YAML; it runs on the rule's next alerts.</p>
        ) : (
          <>
            <p className="strong">{rb.name}</p>
            {rb.type === "text" ? (
              <p className="prose">{rb.content}</p>
            ) : (
              <ol className="rb-steps">
                {(rb.steps ?? []).map((st, i) => (
                  <li key={i}>
                    <span>{String(st.name ?? st.action)}</span>
                    <span className="step-tags">
                      <span className="tag mono">{String(st.action)}</span>
                      {st.approval === "required" ? <span className="tag warn">needs approval</span> : null}
                    </span>
                  </li>
                ))}
              </ol>
            )}
            <button type="button" className="link-btn" aria-expanded={showYaml} onClick={() => setShowYaml(!showYaml)}>
              {showYaml ? "Hide YAML" : "View YAML"}
            </button>
            {showYaml ? <pre className="mono raw-json">{current?.yaml}</pre> : null}
          </>
        )}
      </div>
    </section>
  );
}

function ResolutionCard({ alert }: { alert: Alert }) {
  const d = parseTimestamp("at", alert.resolvedAt);
  return (
    <section aria-label="Resolution" className="ad-panel">
      <div className="panel-head">
        <h2 className="resolved-title">
          <Icon as={CheckCircle2} /> Resolved
        </h2>
        {alert.resolvedBy || d ? (
          <span className="muted small-text">
            {alert.resolvedBy ? `by ${alert.resolvedBy}` : ""}
            {alert.resolvedBy && d ? ", " : ""}
            {d ? formatDate(d) : ""}
          </span>
        ) : null}
      </div>
      <div className="panel-body">
        {alert.resolution ? <p className="prose">{alert.resolution}</p> : <p className="muted">No resolution note.</p>}
      </div>
    </section>
  );
}

/** Resolve form. The text box only appears when the fix is being saved to the rulebook. */
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
  const [text, setText] = useState("");
  const [contribute, setContribute] = useState(false);
  const trimmed = text.trim();
  const blocked = busy || (contribute && trimmed === "");
  return (
    <section aria-label="Resolve alert" className="ad-panel resolve-panel">
      <div className="panel-head">
        <h2>Resolve this alert</h2>
      </div>
      <div className="panel-body stack">
        <label className="check">
          <input type="checkbox" checked={contribute} onChange={(e) => setContribute(e.target.checked)} />
          <span className="check-text">
            <strong>Save to the rulebook</strong>
            <span className="muted">
              Write how you fixed it. It's added as a comment under How to resolve on every alert of rule{" "}
              <span className="mono">{alert.ruleId ?? "this rule"}</span>.
            </span>
          </span>
        </label>
        {contribute ? (
          <>
            <label className="field-label" htmlFor="resolution">
              How was it resolved?
            </label>
            <textarea
              id="resolution"
              rows={8}
              autoFocus
              value={text}
              placeholder="Steps, commands, who to contact…"
              onChange={(e) => setText(e.target.value)}
            />
          </>
        ) : null}
        <div className="actions">
          <button
            type="button"
            className="btn primary solid"
            disabled={blocked}
            onClick={() => onResolve(contribute ? { resolution: trimmed, contribute: true } : {})}
          >
            {contribute ? "Resolve and save" : "Resolve"}
          </button>
          <button type="button" className="btn" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </section>
  );
}

/** Acknowledge / Resolve buttons that show the current state: pressed when chosen, locked once resolved. */
function StateActions({
  state,
  busy,
  resolving,
  onAck,
  onUnack,
  onResolve,
}: {
  state: string;
  busy: boolean;
  resolving: boolean;
  onAck(): void;
  onUnack(): void;
  onResolve(): void;
}) {
  if (state === "resolved") {
    return (
      <div className="actions head-actions" role="group" aria-label="Alert actions">
        <span className="state-btn locked" title="Resolved alerts can't be changed">
          <Icon as={Lock} /> Resolved
        </span>
      </div>
    );
  }
  const acked = state === "acknowledged";
  return (
    <div className="actions head-actions" role="group" aria-label="Alert actions">
      {acked ? (
        <span className="btn-pair">
          <button type="button" className="state-btn on" aria-pressed="true" disabled title="Acknowledged">
            <Icon as={Check} /> Acknowledged
          </button>
          <button type="button" className="state-btn undo" disabled={busy} onClick={onUnack} title="Undo acknowledge">
            <Icon as={Undo2} /> Undo
          </button>
        </span>
      ) : (
        <button type="button" className="state-btn" aria-pressed="false" disabled={busy} onClick={onAck}>
          Acknowledge
        </button>
      )}
      <button
        type="button"
        className={resolving ? "state-btn resolve on" : "state-btn resolve"}
        aria-pressed={resolving}
        disabled={busy || resolving}
        onClick={onResolve}
      >
        {resolving ? <Icon as={Check} /> : null} Resolve…
      </button>
    </div>
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
      const added = (updated as { rulebookComment?: RulebookEntry }).rulebookComment;
      setAlert((prev) => {
        const next = { ...(prev ?? {}), ...updated } as Alert & { rulebookComment?: RulebookEntry };
        delete next.rulebookComment;
        if (added) next.rulebook = [...(prev?.rulebook ?? []), added];
        return next;
      });
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
        <StateActions
          state={state}
          busy={busy}
          resolving={resolving}
          onAck={() => act(ackAlert)}
          onUnack={() => act(unackAlert)}
          onResolve={() => setResolving(true)}
        />
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

      {message ? (
        <section aria-label="Message" className="ad-panel">
          <div className="panel-head"><h2>Message</h2></div>
          <div className="panel-body">
            <p className="prose">{message}</p>
          </div>
        </section>
      ) : null}

      <section aria-label="Alert fields" className="ad-panel">
        <div className="panel-head"><h2>Details</h2></div>
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
        <section aria-label="Event data" className="ad-panel">
          <div className="panel-head"><h2>Event</h2></div>
          <div className="panel-body">
            <p className="muted">—</p>
          </div>
        </section>
      )}

      <div className="two-col">
        <Runbooks runs={runs} />
        <Audit entries={audit} />
      </div>

      {alert.ruleId ? <RuleRunbookPanel ruleId={alert.ruleId} /> : null}

      <RulebookThread
        alertId={id}
        ruleId={alert.ruleId}
        entries={alert.rulebook ?? []}
        onAdded={(e) => setAlert((prev) => (prev ? { ...prev, rulebook: [...(prev.rulebook ?? []), e] } : prev))}
      />
      <Suggest key={id} id={id} />
    </main>
  );
}
