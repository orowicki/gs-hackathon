import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import type { Rule } from "@alerting/shared";
import { FilterBar } from "../../components/filter-bar";
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
import { buildRule, emptyDraft, moveRow, newWhoDraft, ruleToDraft, slugify, SEVERITY_OPTIONS, validateDraft, type RuleDraft, type WhoDraft } from "./helpers";
import "./rules.css";

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

export function RuleEditorPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [loadedRule, setLoadedRule] = useState<Rule | undefined>(undefined);
  const [idTouched, setIdTouched] = useState(false);
  const isNew = id === undefined;
  const [draft, setDraft] = useState<RuleDraft>(emptyDraft());
  const [loaded, setLoaded] = useState(isNew);
  const [errors, setErrors] = useState<string[]>([]);
  const [saved, setSaved] = useState((location.state as { saved?: boolean } | null)?.saved === true);
  const [test, setTest] = useState<TestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [sugError, setSugError] = useState<string | null>(null);
  const [yaml, setYaml] = useState<string | null>(null);

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
      (e: Error) => live && setSugError("Could not load suggestions: " + e.message),
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
      <main className="rules-page">
        <p role="alert" className="error">
          {errors[0]}
        </p>
        <Link to="/rules">Back to rules</Link>
      </main>
    );
  }
  if (!loaded) return <main className="rules-page muted">Loading…</main>;

  return (
    <main className="rules-page">
      <div className="bar">
        <h1>{isNew ? "New rule" : "Edit rule"}</h1>
        <Link to="/rules">Back to rules</Link>
      </div>

      <section className="step" aria-labelledby="step-when">
        <h2 id="step-when">When</h2>
        <label>
          Name
          <input
            type="text"
            value={draft.name}
            onChange={(e) => set(idTouched || !isNew ? { name: e.target.value } : { name: e.target.value, id: slugify(e.target.value) })}
          />
        </label>
        {isNew && (
          <label>
            Id
            <input
              type="text"
              value={draft.id}
              onChange={(e) => {
                setIdTouched(true);
                set({ id: e.target.value });
              }}
            />
          </label>
        )}
        <label className="inline">
          <input type="checkbox" checked={draft.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
          Enabled
        </label>
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
          starred={[]}
          onToggleStar={noop}
        />
        <div className="actions">
          <button type="button" onClick={runTest}>
            Test against recent events
          </button>
          {test && (
            <span className="result" role="status">
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
      </section>

      <section className="step" aria-labelledby="step-who">
        <h2 id="step-who">Who</h2>
        {draft.who.length === 0 && <p className="muted">No rows. Add one to notify people.</p>}
        {draft.who.map((w, i) => (
          <div key={w.key} className="who-row" role="group" aria-label={`Who row ${i + 1}`}>
            <label>
              Condition (optional)
              <input type="text" value={w.condition} onChange={(e) => setRow(w.key, { condition: e.target.value })} />
            </label>
            <label>
              Recipients (person:id or group:id, comma separated)
              <input type="text" value={w.recipients} onChange={(e) => setRow(w.key, { recipients: e.target.value })} />
            </label>
            <label>
              Force channels (optional, comma separated)
              <input type="text" value={w.force} onChange={(e) => setRow(w.key, { force: e.target.value })} />
            </label>
            <div className="actions">
              <button type="button" disabled={i === 0} onClick={() => set((d) => ({ who: moveRow(d.who, i, i - 1) }))}>
                Move up
              </button>
              <button type="button" disabled={i === draft.who.length - 1} onClick={() => set((d) => ({ who: moveRow(d.who, i, i + 1) }))}>
                Move down
              </button>
              <button type="button" onClick={() => set((d) => ({ who: d.who.filter((x) => x.key !== w.key) }))}>
                Remove row
              </button>
            </div>
          </div>
        ))}
        <button type="button" onClick={() => set((d) => ({ who: [...d.who, newWhoDraft()] }))}>
          Add row
        </button>
      </section>

      <section className="step" aria-labelledby="step-looks">
        <h2 id="step-looks">Looks</h2>
        <label>
          Title template
          <input type="text" value={draft.titleTemplate} onChange={(e) => set({ titleTemplate: e.target.value })} />
        </label>
        <label>
          Body template
          <textarea value={draft.bodyTemplate} onChange={(e) => set({ bodyTemplate: e.target.value })} />
        </label>
        <label>
          Fields to show (comma separated)
          <input type="text" value={draft.fields} onChange={(e) => set({ fields: e.target.value })} />
        </label>
        <label>
          Severity override
          <select value={draft.severityOverride} onChange={(e) => set({ severityOverride: e.target.value })}>
            <option value="">(none)</option>
            {SEVERITY_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label>
          Colour
          <input type="text" value={draft.colour} onChange={(e) => set({ colour: e.target.value })} />
        </label>
      </section>

      {errors.map((m) => (
        <p key={m} role="alert" className="error">
          {m}
        </p>
      ))}
      <div className="actions">
        <button type="button" onClick={save}>
          Save rule
        </button>
        {!isNew && (
          <button type="button" onClick={doExport}>
            Export YAML
          </button>
        )}
        {saved && <span role="status">Saved</span>}
      </div>
      {yaml !== null && <pre aria-label="Exported YAML">{yaml}</pre>}

      {!isNew && (
        <section className="step" aria-labelledby="step-sug">
          <h2 id="step-sug">Suggestions</h2>
          {suggestions.length === 0 && !sugError && <p className="muted">No open suggestions.</p>}
          {sugError && (
            <p role="alert" className="error">
              {sugError}
            </p>
          )}
          <ul className="plain">
            {suggestions.map((s) => (
              <li key={s.id} className="row">
                <span>
                  {s.text} <span className="muted">by {s.author}</span>
                </span>
                <span className="actions">
                  <button type="button" onClick={() => act(s, acceptSuggestion)}>
                    Accept
                  </button>
                  <button type="button" onClick={() => act(s, dismissSuggestion)}>
                    Dismiss
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
