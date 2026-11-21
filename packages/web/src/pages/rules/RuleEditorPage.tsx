import { ArrowDown, ArrowUp, Plus, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import type { RecipientRef, Rule } from "@alerting/shared";
import { FilterBar } from "../../components/filter-bar";
import { Icon } from "../../components/Icon";
import { useStarredFilters } from "../../starred";
import { MultiSelect } from "../../components/MultiSelect";
import { useFieldCatalog } from "./fields";
import { TemplateInput } from "./TemplateInput";
import {
  acceptSuggestion,
  createRule,
  dismissSuggestion,
  downloadText,
  exportYaml,
  getRule,
  listSuggestions,
  testFilter,
  updateRule,
  type Suggestion,
  type TestResult,
} from "./api";
import { useDirectory, type DirEntry, type Directory } from "./directory";
import {
  buildRule,
  emptyDraft,
  moveRow,
  newWhoDraft,
  parseRecipients,
  recipientsText,
  ruleToDraft,
  slugify,
  splitList,
  SEVERITY_OPTIONS,
  validateDraft,
  type RuleDraft,
  type WhoDraft,
} from "./helpers";
import "./rules.css";
import { channelLabel } from "../../channels";

const FIELDS = [
  "alert.severity",
  "alert.title",
  "alert.source",
  "alert.environment",
  "alert.status",
  "alert.dedupKey",
  "alert.schema",
];
const VALUES: Record<string, string[]> = {
  "alert.severity": ["critical", "error", "warning", "info"],
  "alert.environment": ["prod", "staging", "dev"],
};
const valuesFor = (f: string) => VALUES[f] ?? [];
const noop = () => {};

/** Sample values for the title preview, from the Appendix A events. */
const SAMPLE: Record<string, string> = {
  "alert.title": "HighErrorRate on payments-api",
  "alert.source": "payments-api",
  "alert.severity": "critical",
  "alert.environment": "prod",
  "alert.status": "open",
  "alert.schema": "metric.breach",
  failedStep: "validate-counterparty",
  workflowName: "order-settlement",
  "payload.desk": "rates",
  "payload.notional": "25000000",
  errorMessage: "Counterparty service did not respond in 5000 ms",
};
const render = (t: string) =>
  t.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k: string) => SAMPLE[k] ?? `‹${k}›`);

const SEV_LABEL: Record<string, string> = {
  "": "Keep the event's",
  critical: "Critical",
  error: "Error",
  warning: "Warning",
  info: "Info",
};

const DEDUP_OPTIONS = ["source", "title", "environment", "severity"];
const COLOURS: { value: string; label: string }[] = [
  { value: "", label: "Severity colour (default)" },
  { value: "#f2495c", label: "Red" },
  { value: "#ff9830", label: "Orange" },
  { value: "#fade2a", label: "Yellow" },
  { value: "#73bf69", label: "Green" },
  { value: "#7399c6", label: "Brand blue" },
  { value: "#b877d9", label: "Purple" },
];

/** Comma-separated list edited as toggles, with an optional box for other values. */
function ListToggles({
  label,
  value,
  options,
  onChange,
  allowCustom = false,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
  allowCustom?: boolean;
}) {
  const on = splitList(value);
  const [typed, setTyped] = useState("");
  const all = [...new Set([...options, ...on])];
  const flip = (x: string) => onChange((on.includes(x) ? on.filter((y) => y !== x) : [...on, x]).join(", "));
  return (
    <div className="toggles" role="group" aria-label={label}>
      {all.map((x) => (
        <button key={x} type="button" aria-pressed={on.includes(x)} className={on.includes(x) ? "toggle on mono" : "toggle mono"} onClick={() => flip(x)}>
          {x}
        </button>
      ))}
      {allowCustom && (
        <input
          className="toggle-add mono"
          aria-label={`Add to ${label.toLowerCase()}`}
          placeholder="other field, Enter"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || typed.trim() === "") return;
            e.preventDefault();
            if (!on.includes(typed.trim())) onChange([...on, typed.trim()].join(", "));
            setTyped("");
          }}
        />
      )}
    </div>
  );
}

/** The alert as it will look in the feed: collapsed row plus the expanded facts. */
const PREVIEW_FIELDS = 8;

function AlertPreview({ draft }: { draft: RuleDraft }) {
  const [showAll, setShowAll] = useState(false);
  const sev = draft.severityOverride || "error";
  const label: Record<string, string> = { critical: "CRIT", error: "ERR", warning: "WARN", info: "INFO" };
  const fields = splitList(draft.fields);
  return (
    <div className="alert-preview" aria-label="Alert preview">
      <div className="alert-preview-caption">Preview with sample event data</div>
      <div className={`alert-preview-row sev-${sev}`} style={draft.colour ? { boxShadow: `inset 3px 0 0 ${draft.colour}` } : undefined}>
        <span className="sev-label">{label[sev]}</span>
        <span className="alert-preview-title">{render(draft.titleTemplate) || "Untitled alert"}</span>
        <span className="alert-preview-meta">payments-api</span>
        <span className="alert-preview-meta">now</span>
        <span className="alert-preview-count">×3</span>
      </div>
      {(draft.bodyTemplate.trim() || fields.length > 0) && (
        <div className="alert-preview-body">
          {draft.bodyTemplate.trim() && <p>{render(draft.bodyTemplate)}</p>}
          {fields.length > 0 && (
            <>
              <dl className="alert-preview-facts">
                {(showAll ? fields : fields.slice(0, PREVIEW_FIELDS)).map((f) => (
                  <div key={f}>
                    <dt title={f}>{f}</dt>
                    <dd>{SAMPLE[f] ?? "…"}</dd>
                  </div>
                ))}
              </dl>
              {fields.length > PREVIEW_FIELDS && (
                <button type="button" className="link-btn alert-preview-more" onClick={() => setShowAll((v) => !v)}>
                  {showAll ? "Show fewer" : `and ${fields.length - PREVIEW_FIELDS} more`}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Step header: number, title (the heading), one line of help. */
function Step({ n, title, help, children }: { n: number; title: string; help: string; children: React.ReactNode }) {
  const id = "step-" + title.toLowerCase().replace(/\W+/g, "-");
  return (
    <section className="re-step" aria-labelledby={id}>
      <div className="re-step-num" aria-hidden="true">
        {n}
      </div>
      <div className="re-step-body">
        <h2 id={id}>{title}</h2>
        <p className="re-help">{help}</p>
        {children}
      </div>
    </section>
  );
}

function nameOf(dir: Directory, r: RecipientRef): string {
  return dir.entries.find((e) => e.type === r.type && e.id === r.id)?.name ?? r.id;
}

/** Recipients as chips; add from the people/groups list (or by id if it couldn't load). */
function RecipientPicker({ value, onChange, dir }: { value: string; onChange: (v: string) => void; dir: Directory }) {
  const refs = parseRecipients(value);
  const [typed, setTyped] = useState("");
  const chosen = new Set(refs.map((r) => `${r.type}:${r.id}`));
  const available = dir.entries.filter((e) => !chosen.has(`${e.type}:${e.id}`));
  const add = (r: RecipientRef) => onChange(recipientsText([...refs, r]));
  const remove = (i: number) => onChange(recipientsText(refs.filter((_, j) => j !== i)));
  const option = (e: DirEntry) => `${e.type}:${e.id}`;
  return (
    <div className="chips" aria-label="Recipients">
      {refs.map((r, i) => (
        <span key={`${r.type}:${r.id}`} className={`chip chip-${r.type}`}>
          <span className="chip-kind">{r.type === "group" ? "Group" : "Person"}</span>
          {nameOf(dir, r)}
          <button type="button" className="chip-x" aria-label={`Remove ${nameOf(dir, r)}`} onClick={() => remove(i)}>
            <X size={12} aria-hidden="true" />
          </button>
        </span>
      ))}
      {dir.ok ? (
        <select
          className="chip-add"
          aria-label="Add a person or group"
          value=""
          onChange={(e) => {
            const [type, ...rest] = e.target.value.split(":");
            if (type === "person" || type === "group") add({ type, id: rest.join(":") });
          }}
        >
          <option value="">Add person or group…</option>
          {available.some((e) => e.type === "group") && (
            <optgroup label="Groups">
              {available.filter((e) => e.type === "group").map((e) => (
                <option key={option(e)} value={option(e)}>
                  {e.name} ({e.detail})
                </option>
              ))}
            </optgroup>
          )}
          {available.some((e) => e.type === "person") && (
            <optgroup label="People">
              {available.filter((e) => e.type === "person").map((e) => (
                <option key={option(e)} value={option(e)}>
                  {e.name}
                  {e.detail ? ` (${e.detail})` : ""}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      ) : (
        <input
          className="chip-add"
          aria-label="Add recipient id"
          placeholder="group:oncall or a person id, then Enter"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || typed.trim() === "") return;
            e.preventDefault();
            const [r] = parseRecipients(typed);
            if (r) add(r);
            setTyped("");
          }}
        />
      )}
    </div>
  );
}

/** Channels as toggles; "forced" channels bypass each person's preferences. */
function ChannelToggles({ value, onChange, channels }: { value: string; onChange: (v: string) => void; channels: string[] }) {
  const on = splitList(value);
  const all = [...new Set([...channels, ...on])];
  return (
    <div className="toggles" role="group" aria-label="Always send via">
      {all.map((c) => {
        const active = on.includes(c);
        return (
          <button
            key={c}
            type="button"
            aria-pressed={active}
            className={active ? "toggle on" : "toggle"}
            onClick={() => onChange((active ? on.filter((x) => x !== c) : [...on, c]).join(", "))}
          >
            {channelLabel(c)}
          </button>
        );
      })}
    </div>
  );
}

function Summary({ draft, dir }: { draft: RuleDraft; dir: Directory }) {
  const rows = draft.who.filter((w) => w.recipients.trim() !== "");
  return (
    <aside className="re-summary" aria-label="Rule summary">
      <h2>Summary</h2>
      <p className="re-sentence">
        {draft.when.trim() ? (
          <>
            When an event matches <code>{draft.when.trim()}</code>,
          </>
        ) : (
          <>For every event,</>
        )}{" "}
        {rows.length === 0 ? (
          <>raise an alert but notify nobody yet.</>
        ) : (
          <>
            notify{" "}
            {rows
              .map((w) => {
                const names = parseRecipients(w.recipients).map((r) => nameOf(dir, r)).join(", ");
                const cond = w.condition.trim() ? ` when ${w.condition.trim()}` : "";
                const force = splitList(w.force);
                return `${names}${cond}${force.length ? ` (always via ${force.map(channelLabel).join(", ")})` : ""}`;
              })
              .join("; then ")}
            .
          </>
        )}
      </p>
      <dl className="re-facts">
        <div>
          <dt>Status</dt>
          <dd>
            <span className={draft.enabled ? "tag ok" : "tag"}>{draft.enabled ? "Enabled" : "Disabled"}</span>
          </dd>
        </div>
        <div>
          <dt>Alert title</dt>
          <dd>{render(draft.titleTemplate) || "—"}</dd>
        </div>
        <div>
          <dt>Severity</dt>
          <dd>{SEV_LABEL[draft.severityOverride] ?? draft.severityOverride}</dd>
        </div>
      </dl>
    </aside>
  );
}

export function RuleEditorPage({ initial, tabs }: { initial?: RuleDraft; tabs?: React.ReactNode } = {}) {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const dir = useDirectory();
  const starredFilters = useStarredFilters();
  const catalog = useFieldCatalog();
  const [loadedRule, setLoadedRule] = useState<Rule | undefined>(undefined);
  const [idTouched, setIdTouched] = useState(initial !== undefined);
  const isNew = id === undefined;
  const [draft, setDraft] = useState<RuleDraft>(initial ?? emptyDraft());
  const [loaded, setLoaded] = useState(isNew);
  const [errors, setErrors] = useState<string[]>([]);
  const [saved, setSaved] = useState((location.state as { saved?: boolean } | null)?.saved === true);
  const [test, setTest] = useState<TestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [sugError, setSugError] = useState<string | null>(null);
  const [yaml, setYaml] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (id === undefined) return;
    let live = true;
    getRule(id).then(
      (r) => {
        if (!live) return;
        setLoadedRule(r);
        setDraft(ruleToDraft(r));
        setLoaded(true);
      },
      (e: Error) => live && setErrors([e.message]),
    );
    listSuggestions(id).then(
      (s) => live && setSuggestions(s.filter((x) => x.status === "open")),
      (e: Error) => live && setSugError("Couldn't load suggestions: " + e.message),
    );
    return () => {
      live = false;
    };
  }, [id]);

  const set = (p: Partial<RuleDraft> | ((d: RuleDraft) => Partial<RuleDraft>)) => {
    setDraft((d) => ({ ...d, ...(typeof p === "function" ? p(d) : p) }));
    setSaved(false);
  };
  const setRow = (key: string, p: Partial<WhoDraft>) =>
    set((d) => ({ who: d.who.map((w) => (w.key === key ? { ...w, ...p } : w)) }));

  async function save() {
    const problems = validateDraft(draft, isNew);
    setErrors(problems);
    setSaved(false);
    if (problems.length > 0) return;
    setSaving(true);
    try {
      if (isNew) {
        const rule = await createRule(buildRule(draft, { id: draft.id }));
        navigate("/rules/" + encodeURIComponent(rule.id), { replace: true, state: { saved: true } });
      } else {
        const rule = await updateRule(id, buildRule(draft, { id, loaded: loadedRule }));
        setLoadedRule(rule);
        setDraft(ruleToDraft(rule));
        setSaved(true);
      }
    } catch (e) {
      setErrors([(e as Error).message]);
    } finally {
      setSaving(false);
    }
  }

  async function runTest() {
    setTest(null);
    setTestError(null);
    try {
      setTest(await testFilter(draft.when.trim()));
    } catch (e) {
      setTestError((e as Error).message);
    }
  }

  async function act(s: Suggestion, fn: (id: string) => Promise<unknown>) {
    setSugError(null);
    try {
      await fn(s.id);
      setSuggestions((l) => l.filter((x) => x.id !== s.id));
    } catch (e) {
      setSugError((e as Error).message);
    }
  }

  async function doExport() {
    if (id === undefined) return;
    try {
      const text = await exportYaml(id);
      setYaml(text);
      downloadText(id + ".yaml", text);
    } catch (e) {
      setErrors([(e as Error).message]);
    }
  }

  if (!loaded && errors.length > 0) {
    return (
      <main className="page rules-page">
        <p role="alert" className="callout error">
          {errors[0]}
        </p>
        <Link to="/rules">Back to rules</Link>
      </main>
    );
  }
  if (!loaded) return <main className="page rules-page muted">Loading rule…</main>;

  return (
    <main className="page rules-page re-page">
      <header className="page-header">
        <div>
          <h1>{isNew ? "New rule" : draft.name || "Edit rule"}</h1>
          <p className="page-intro">
            {isNew ? "Four steps. The summary on the right shows what the rule will do." : `Rule id ${draft.id}`}
          </p>
        </div>
      </header>
      {tabs}

      <div className="re-layout">
        <div className="re-steps">
          <Step n={1} title="Name and status" help="A name people will recognise in notifications.">
            <div className="re-grid-2">
              <label className="field">
                Name
                <input
                  type="text"
                  value={draft.name}
                  placeholder="Payments critical alerts"
                  onChange={(e) =>
                    set(idTouched || !isNew ? { name: e.target.value } : { name: e.target.value, id: slugify(e.target.value) })
                  }
                />
              </label>
              {isNew && (
                <label className="field">
                  Id
                  <input
                    type="text"
                    className="mono"
                    value={draft.id}
                    onChange={(e) => {
                      setIdTouched(true);
                      set({ id: e.target.value });
                    }}
                  />
                </label>
              )}
            </div>
            <label className="switch">
              <input type="checkbox" checked={draft.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
              <span className="switch-track" aria-hidden="true" />
              Enabled
            </label>
          </Step>

          <Step n={2} title="When" help="Which events raise an alert. Leave it empty to match every event.">
            <FilterBar
              value={draft.when}
              onChange={(t) => {
                set({ when: t });
                setTest(null);
                setTestError(null);
              }}
              onApply={noop}
              fields={FIELDS}
              valuesFor={valuesFor}
              starred={starredFilters.texts}
              onToggleStar={starredFilters.toggle}
            />
            <div className="re-inline">
              <button type="button" className="btn" onClick={runTest}>
                Test against recent events
              </button>
              {test && (
                <span className={test.matched > 0 ? "re-result hit" : "re-result"} role="status">
                  Matches {test.matched} of {test.total} recent events
                  {test.warning && <span className="warn"> ({test.warning})</span>}
                </span>
              )}
              {testError && (
                <span role="alert" className="error">
                  {testError}
                </span>
              )}
            </div>
          </Step>

          <Step
            n={3}
            title="Who"
            help="Rows are checked top to bottom; each person is notified by the first row that includes them."
          >
            {draft.who.length === 0 && <p className="re-empty">Nobody is notified yet. Add a row to choose who hears about it.</p>}
            <ol className="who-list">
              {draft.who.map((w, i) => (
                <li key={w.key} className="who-card" role="group" aria-label={`Who row ${i + 1}`}>
                  <div className="who-head">
                    <div className="segmented-sm" role="radiogroup" aria-label="Applies to">
                      <button
                        type="button"
                        role="radio"
                        aria-checked={w.condition.trim() === ""}
                        className={w.condition.trim() === "" ? "seg on" : "seg"}
                        onClick={() => setRow(w.key, { condition: "" })}
                      >
                        Every alert
                      </button>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={w.condition.trim() !== ""}
                        className={w.condition.trim() !== "" ? "seg on" : "seg"}
                        onClick={() => w.condition.trim() === "" && setRow(w.key, { condition: "alert.environment = prod" })}
                      >
                        Only when…
                      </button>
                    </div>
                    <div className="who-tools">
                      <button type="button" className="icon-btn" aria-label="Move up" disabled={i === 0} onClick={() => set((d) => ({ who: moveRow(d.who, i, i - 1) }))}>
                        <Icon as={ArrowUp} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label="Move down"
                        disabled={i === draft.who.length - 1}
                        onClick={() => set((d) => ({ who: moveRow(d.who, i, i + 1) }))}
                      >
                        <Icon as={ArrowDown} />
                      </button>
                      <button type="button" className="icon-btn" aria-label="Remove row" onClick={() => set((d) => ({ who: d.who.filter((x) => x.key !== w.key) }))}>
                        <Icon as={Trash2} />
                      </button>
                    </div>
                  </div>
                  {w.condition.trim() !== "" && (
                    <label className="field">
                      Condition
                      <input type="text" className="mono" value={w.condition} onChange={(e) => setRow(w.key, { condition: e.target.value })} />
                    </label>
                  )}
                  <div className="field">
                    <span className="field-label">Notify</span>
                    <RecipientPicker value={w.recipients} onChange={(v) => setRow(w.key, { recipients: v })} dir={dir} />
                  </div>
                  <div className="field">
                    <span className="field-label">Always send via</span>
                    <ChannelToggles value={w.force} onChange={(v) => setRow(w.key, { force: v })} channels={dir.channels} />
                    <span className="re-hint">Selected channels ignore people's notification preferences and quiet hours.</span>
                  </div>
                </li>
              ))}
            </ol>
            <button type="button" className="btn" onClick={() => set((d) => ({ who: [...d.who, newWhoDraft()] }))}>
              <Plus size={14} aria-hidden="true" /> Add row
            </button>
          </Step>

          <Step n={4} title="Looks" help="How the alert reads in the feed and in notifications. The preview updates as you type.">
            <AlertPreview draft={draft} />
            <div className="field">
              <label htmlFor="looks-title" className="field-label">
                Title
              </label>
              <TemplateInput id="looks-title" value={draft.titleTemplate} onChange={(v) => set({ titleTemplate: v })} fields={catalog} />
            </div>
            <div className="field">
              <label htmlFor="looks-body" className="field-label">
                Message
              </label>
              <TemplateInput
                id="looks-body"
                multiline
                placeholder="{{alert.source}} reported {{alert.title}} in {{alert.environment}}."
                value={draft.bodyTemplate}
                onChange={(v) => set({ bodyTemplate: v })}
                fields={catalog}
              />
            </div>
            <div className="field">
              <span className="field-label">Severity</span>
              <div className="segmented-sm" role="radiogroup" aria-label="Severity">
                {["", ...SEVERITY_OPTIONS].map((sv) => (
                  <button
                    key={sv || "keep"}
                    type="button"
                    role="radio"
                    aria-checked={draft.severityOverride === sv}
                    className={`seg${draft.severityOverride === sv ? " on" : ""}${sv ? ` sev-${sv}` : ""}`}
                    onClick={() => set({ severityOverride: sv })}
                  >
                    {SEV_LABEL[sv]}
                  </button>
                ))}
              </div>
            </div>
            <div className="field">
              <span className="field-label">Fields to show when expanded</span>
              <MultiSelect
                label="Fields to show"
                options={catalog}
                selected={splitList(draft.fields)}
                onChange={(next) => set({ fields: next.join(", ") })}
                allowCustom
                placeholder="Choose fields…"
              />
            </div>
            <div className="re-grid-2">
              <div className="field">
                <span className="field-label">Colour</span>
                <div className="swatches" role="radiogroup" aria-label="Colour">
                  {COLOURS.map((c) => (
                    <button
                      key={c.value || "none"}
                      type="button"
                      role="radio"
                      aria-checked={draft.colour === c.value}
                      aria-label={c.label}
                      title={c.label}
                      className={draft.colour === c.value ? "swatch on" : "swatch"}
                      style={c.value ? { background: c.value } : undefined}
                      onClick={() => set({ colour: c.value })}
                    />
                  ))}
                </div>
              </div>
              <div className="field">
                <span className="field-label">Group repeats by</span>
                <ListToggles label="Group repeats by" value={draft.dedupFields} options={DEDUP_OPTIONS} onChange={(v) => set({ dedupFields: v })} />
                <span className="re-hint">Events with the same values become one alert with a count. Empty: the event's own key.</span>
              </div>
            </div>
          </Step>

          {!isNew && (
            <section className="re-suggestions" aria-labelledby="step-sug">
              <h2 id="step-sug">Suggestions</h2>
              {suggestions.length === 0 && !sugError && <p className="muted">No open suggestions.</p>}
              {sugError && (
                <p role="alert" className="error">
                  {sugError}
                </p>
              )}
              <ul className="plain">
                {suggestions.map((s) => (
                  <li key={s.id} className="sug">
                    <span>
                      {s.text} <span className="muted">by {s.author}</span>
                    </span>
                    <span className="re-inline">
                      <button type="button" className="btn primary" onClick={() => act(s, acceptSuggestion)}>
                        Accept
                      </button>
                      <button type="button" className="btn" onClick={() => act(s, dismissSuggestion)}>
                        Dismiss
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {yaml !== null && (
            <pre className="code-block" aria-label="Exported YAML">
              {yaml}
            </pre>
          )}
        </div>

        <Summary draft={draft} dir={dir} />
      </div>

      <footer className="action-bar">
        <div className="action-bar-msgs">
          {errors.map((m) => (
            <p key={m} role="alert" className="error">
              {m}
            </p>
          ))}
          {saved && (
            <span role="status" className="saved">
              Saved
            </span>
          )}
        </div>
        <Link className="btn" to="/rules">
          {isNew ? "Cancel" : "Back to rules"}
        </Link>
        {!isNew && (
          <button type="button" className="btn" onClick={doExport}>
            Export YAML
          </button>
        )}
        <button type="button" className="btn primary" disabled={saving} onClick={save}>
          Save rule
        </button>
      </footer>
    </main>
  );
}
