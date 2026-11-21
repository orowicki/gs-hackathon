import type { Runbook, RunbookStep } from "@alerting/shared";
import { ArrowDown, ArrowUp, Download, FileText, ListOrdered, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { stringify } from "yaml";
import { Step } from "../../components/EditorStep";
import { FilterBar } from "../../components/filter-bar";
import { Icon } from "../../components/Icon";
import { useFieldCatalog } from "../rules/fields";
import { TemplateInput } from "../rules/TemplateInput";
import { ACTIONS, ID_RE, newStep, RUNBOOK_INTRO, slugify, stepSentence, stripKey, switchAction, validateRunbook, withKey, type DraftStep } from "./helpers";
import "./runbooks.css";

interface Group {
  id: string;
  name: string;
}
const noop = () => {};
const METHODS = ["GET", "POST", "PUT", "DELETE"];

function filterText(m: Runbook["matches"]): string {
  return typeof m === "string" ? m : "";
}

function GroupSelect({ label, value, groups, onChange, none }: { label: string; value: string; groups: Group[]; onChange: (v: string) => void; none?: string }) {
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{none ?? "Choose a group…"}</option>
      {groups.map((g) => (
        <option key={g.id} value={g.id}>
          {g.name}
        </option>
      ))}
      {value && !groups.some((g) => g.id === value) && <option value={value}>{value}</option>}
    </select>
  );
}

function StepCard({
  i,
  n,
  step,
  groups,
  fields,
  onChange,
  onMove,
  onRemove,
}: {
  i: number;
  n: number;
  step: DraftStep;
  groups: Group[];
  fields: string[];
  onChange: (s: DraftStep) => void;
  onMove: (to: number) => void;
  onRemove: () => void;
}) {
  const id = (k: string) => `rb-${step.key}-${k}`;
  return (
    <li className={step.approval === "required" ? "rb-step needs" : "rb-step"} role="group" aria-label={`Step ${i + 1}`}>
      <div className="rb-step-head">
        <span className="rb-num">{i + 1}</span>
        <div className="segmented-sm" role="radiogroup" aria-label={`Action for step ${i + 1}`}>
          {ACTIONS.map((a) => (
            <button
              key={a.id}
              type="button"
              role="radio"
              aria-checked={step.action === a.id}
              className={step.action === a.id ? "seg on" : "seg"}
              onClick={() => step.action !== a.id && onChange(switchAction(step, a.id))}
            >
              {a.label}
            </button>
          ))}
        </div>
        <div className="who-tools">
          <button type="button" className="icon-btn" aria-label={`Move step ${i + 1} up`} disabled={i === 0} onClick={() => onMove(i - 1)}>
            <Icon as={ArrowUp} />
          </button>
          <button type="button" className="icon-btn" aria-label={`Move step ${i + 1} down`} disabled={i === n - 1} onClick={() => onMove(i + 1)}>
            <Icon as={ArrowDown} />
          </button>
          <button type="button" className="icon-btn" aria-label={`Remove step ${i + 1}`} onClick={onRemove}>
            <Icon as={Trash2} />
          </button>
        </div>
      </div>

      <div className="field">
        <label htmlFor={id("name")} className="field-label">
          Step name
        </label>
        <TemplateInput id={id("name")} value={step.name ?? ""} onChange={(v) => onChange({ ...step, name: v })} fields={fields} placeholder="Restart {{alert.source}}" hint={false} />
      </div>

      {step.action === "http" && (
        <div className="rb-http">
          <label className="field">
            Method
            <select aria-label={`Method for step ${i + 1}`} value={step.method} onChange={(e) => onChange({ ...step, method: e.target.value })}>
              {METHODS.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
          <div className="field rb-grow">
            <label htmlFor={id("url")} className="field-label">
              URL
            </label>
            <TemplateInput id={id("url")} value={step.url} onChange={(v) => onChange({ ...step, url: v })} fields={fields} placeholder="https://ops.internal/restart/{{alert.source}}" hint={false} />
          </div>
          {step.method !== "GET" && (
            <div className="field rb-full">
              <label htmlFor={id("body")} className="field-label">
                Body (optional)
              </label>
              <TemplateInput
                id={id("body")}
                multiline
                value={step.body ?? ""}
                onChange={(v) => onChange({ ...step, ...(v ? { body: v } : { body: undefined }) })}
                fields={fields}
                placeholder='{"reason": "{{alert.title}}"}'
                hint={false}
              />
            </div>
          )}
        </div>
      )}
      {step.action === "escalate" && (
        <label className="field">
          Escalate to
          <GroupSelect label={`Group for step ${i + 1}`} value={step.group} groups={groups} onChange={(g) => onChange({ ...step, group: g })} />
        </label>
      )}
      {step.action === "wait" && (
        <label className="field rb-short">
          Wait for
          <input type="text" className="mono" value={step.duration} placeholder="5m" onChange={(e) => onChange({ ...step, duration: e.target.value })} />
        </label>
      )}

      <span className="re-hint">
        Names, URLs and bodies can use alert values: type <kbd>{"{{"}</kbd> in any of them.
      </span>

      <div className="rb-approval">
        <label className="switch">
          <input
            type="checkbox"
            checked={step.approval === "required"}
            onChange={(e) => onChange({ ...step, approval: e.target.checked ? "required" : "none" })}
          />
          <span className="switch-track" aria-hidden="true" />
          Needs a person's approval before it runs
        </label>
        {step.approval === "required" && (
          <GroupSelect
            label={`Approvers for step ${i + 1}`}
            value={step.approvers ?? ""}
            groups={groups}
            none="The alert's recipients"
            onChange={(g) => onChange({ ...step, ...(g ? { approvers: g } : { approvers: undefined }) })}
          />
        )}
      </div>
    </li>
  );
}

export function RunbookEditor({ initial, isNew, tabs, notice }: { initial: Runbook; isNew: boolean; tabs?: ReactNode; notice?: string }) {
  const navigate = useNavigate();
  const fields = useFieldCatalog();
  const [rb, setRb] = useState<Runbook>(initial);
  const [steps, setSteps] = useState<DraftStep[]>(() => (initial.type === "automation" ? initial.steps.map(withKey) : []));
  const [content, setContent] = useState(initial.type === "text" ? initial.content : "");
  const [matches, setMatches] = useState(filterText(initial.matches));
  const [idTouched, setIdTouched] = useState(!isNew || initial.id !== "");
  const [groups, setGroups] = useState<Group[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [yaml, setYaml] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/groups")
      .then((r) => (r.ok ? (r.json() as Promise<Group[]>) : []))
      .then(setGroups)
      .catch(() => undefined);
  }, []);

  const groupName = (id: string) => groups.find((g) => g.id === id)?.name ?? id;
  const built = (): Runbook =>
    rb.type === "text"
      ? { id: rb.id, name: rb.name.trim(), type: "text", matches: matches.trim(), content }
      : { id: rb.id, name: rb.name.trim(), type: "automation", matches: matches.trim(), steps: steps.map(stripKey) };
  const current = built();
  const setStep = (i: number, s: DraftStep) => setSteps((all) => all.map((x, j) => (j === i ? s : x)));
  const move = (from: number, to: number) =>
    setSteps((all) => {
      const next = [...all];
      const [x] = next.splice(from, 1);
      next.splice(to, 0, x!);
      return next;
    });
  const needsApproval = steps.filter((s) => s.approval === "required");

  async function save() {
    const problems = validateRunbook(current, steps, isNew);
    setErrors(problems);
    if (problems.length) return;
    setBusy(true);
    try {
      const init = { headers: { "content-type": "application/json" }, body: JSON.stringify(current) };
      const res = isNew
        ? await fetch("/api/runbooks", { method: "POST", ...init })
        : await fetch(`/api/runbooks/${encodeURIComponent(rb.id)}`, { method: "PUT", ...init });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
      navigate("/config/runbooks");
    } catch (e) {
      setErrors([(e as Error).message]);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Delete runbook "${rb.name}"? Alerts will no longer show it.`)) return;
    const res = await fetch(`/api/runbooks/${encodeURIComponent(rb.id)}`, { method: "DELETE" });
    if (res.ok) navigate("/config/runbooks");
    else setErrors([`Couldn't delete (HTTP ${res.status}).`]);
  }

  function exportYaml() {
    const text = stringify(current);
    setYaml(text);
    const url = URL.createObjectURL(new Blob([text], { type: "application/yaml" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${rb.id}.yaml`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  return (
    <main className="page rb-page re-page">
      <header className="page-header">
        <div>
          <h1>{isNew ? "New runbook" : rb.name || "Edit runbook"}</h1>
          <p className="page-intro">{isNew ? RUNBOOK_INTRO : `Runbook id ${rb.id}`}</p>
        </div>
      </header>
      {tabs}
      {notice && <p className="callout info">{notice}</p>}

      <div className="re-layout">
        <div className="re-steps">
          <Step n={1} title="Name and id" help="A name people will recognise on the alert.">
            <div className="re-grid-2">
              <label className="field">
                Name
                <input
                  type="text"
                  value={rb.name}
                  placeholder="Restart a pricing engine"
                  onChange={(e) => setRb((r) => ({ ...r, name: e.target.value, ...(idTouched ? {} : { id: slugify(e.target.value) }) }))}
                />
              </label>
              <label className="field">
                Id
                <input
                  type="text"
                  className="mono"
                  value={rb.id}
                  readOnly={!isNew}
                  aria-invalid={isNew && rb.id !== "" && !ID_RE.test(rb.id) ? true : undefined}
                  onChange={(e) => {
                    setIdTouched(true);
                    setRb((r) => ({ ...r, id: e.target.value }));
                  }}
                />
              </label>
            </div>
          </Step>

          <Step n={2} title="When it applies" help="Alerts matching this filter show this runbook. Leave it empty for every alert.">
            <FilterBar value={matches} onChange={setMatches} onApply={noop} fields={fields} valuesFor={() => []} starred={[]} onToggleStar={noop} />
          </Step>

          <Step n={3} title="What it does" help="Written instructions for people, or steps the service runs itself.">
            <div className="rb-kinds" role="radiogroup" aria-label="Kind">
              {(
                [
                  ["automation", ListOrdered, "Automated steps", "HTTP calls, escalations and waits, run in order. Risky steps wait for approval."],
                  ["text", FileText, "Instructions", "A checklist or notes shown on the alert, with values from it filled in."],
                ] as const
              ).map(([kind, icon, title, text]) => (
                <button
                  key={kind}
                  type="button"
                  role="radio"
                  aria-checked={rb.type === kind}
                  className={rb.type === kind ? "src-type on" : "src-type"}
                  onClick={() => setRb((r) => (kind === "text" ? { ...r, type: "text", content } : { ...r, type: "automation", steps: [] }) as Runbook)}
                >
                  <span className="choice-icon">
                    <Icon as={icon} />
                  </span>
                  <span className="choice-title">{title}</span>
                  <span className="choice-text">{text}</span>
                </button>
              ))}
            </div>

            {rb.type === "text" ? (
              <div className="field">
                <label htmlFor="rb-content" className="field-label">
                  Instructions
                </label>
                <TemplateInput id="rb-content" multiline value={content} onChange={setContent} fields={fields} placeholder={"1. Check …\n2. If …, call …"} />
              </div>
            ) : (
              <>
                {steps.length === 0 && <p className="re-empty">No steps yet. Add the first one.</p>}
                <ol className="rb-steps">
                  {steps.map((s, i) => (
                    <StepCard
                      key={s.key}
                      i={i}
                      n={steps.length}
                      step={s}
                      groups={groups}
                      fields={fields}
                      onChange={(x) => setStep(i, x)}
                      onMove={(to) => move(i, to)}
                      onRemove={() => setSteps((all) => all.filter((x) => x.key !== s.key))}
                    />
                  ))}
                </ol>
                <div className="re-inline">
                  {ACTIONS.map((a) => (
                    <button key={a.id} type="button" className="btn" onClick={() => setSteps((all) => [...all, newStep(a.id)])}>
                      <Plus size={14} aria-hidden="true" /> {a.label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </Step>

          {yaml !== null && (
            <pre className="code-block" aria-label="Exported YAML">
              {yaml}
            </pre>
          )}
        </div>

        <aside className="re-summary" aria-label="Runbook summary">
          <h2>Summary</h2>
          <p className="re-sentence">
            {matches.trim() ? (
              <>
                Shown on alerts matching <code>{matches.trim()}</code>.
              </>
            ) : (
              <>Shown on every alert.</>
            )}{" "}
            {rb.type === "text"
              ? "People get written instructions."
              : steps.length === 0
                ? "No steps yet."
                : `Runs ${steps.length} step${steps.length === 1 ? "" : "s"}${needsApproval.length ? `; ${needsApproval.length} wait${needsApproval.length === 1 ? "s" : ""} for approval` : ""}.`}
          </p>
          {rb.type === "automation" && steps.length > 0 && (
            <ol className="rb-mini" aria-label="Steps overview">
              {steps.map((s) => (
                <li key={s.key}>
                  <span className="rb-mini-name">{s.name || stepSentence(s as RunbookStep, groupName)}</span>
                  <span className="rb-mini-what mono">{stepSentence(s as RunbookStep, groupName)}</span>
                  {s.approval === "required" && (
                    <span className="tag sev-warning">
                      <ShieldCheck size={11} aria-hidden="true" /> {s.approvers ? groupName(s.approvers) : "approval"}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          )}
        </aside>
      </div>

      <footer className="action-bar">
        <div className="action-bar-msgs">
          {errors.map((m) => (
            <p key={m} role="alert" className="error">
              {m}
            </p>
          ))}
        </div>
        <Link className="btn" to="/config/runbooks">
          {isNew ? "Cancel" : "Back to runbooks"}
        </Link>
        <button type="button" className="btn" onClick={exportYaml}>
          <Icon as={Download} /> Export YAML
        </button>
        {!isNew && (
          <button type="button" className="btn danger" onClick={() => void remove()}>
            <Icon as={Trash2} /> Delete
          </button>
        )}
        <button type="button" className="btn primary" disabled={busy} onClick={() => void save()}>
          Save runbook
        </button>
      </footer>
    </main>
  );
}
