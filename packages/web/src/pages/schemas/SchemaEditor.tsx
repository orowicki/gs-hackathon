import { Check, ChevronDown, ChevronRight, Download, MousePointerClick, Plus, Trash2, X } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Step } from "../../components/EditorStep";
import { Icon } from "../../components/Icon";
import { getText, sendJson } from "../sources/api";
import { cleanSchema, describeMatch, generateMatch, ID_RE, SCHEMA_INTRO, slugify, testSchema } from "./helpers";
import { MatchFilterInput } from "./MatchFilterInput";
import { COMMON_FIELDS, RESERVED_IDS, type CommonFieldName, type FieldMapping, type MappingKind, type Schema } from "./types";
import "./schemas.css";

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

const KIND_LABEL: Record<MappingKind, string> = { path: "Field", constant: "Fixed", template: "Template" };
const PLACEHOLDER: Record<MappingKind, string> = {
  path: "error.code",
  constant: "prod",
  template: "{{service}}: {{error.message}}",
};
const SEV_SHORT: Record<string, string> = { critical: "CRIT", error: "ERR", warning: "WARN", info: "INFO" };

function parseSample(text: string): { obj?: { [k: string]: Json }; error?: string } {
  if (text.trim() === "") return {};
  try {
    const v = JSON.parse(text) as Json;
    if (v === null || typeof v !== "object" || Array.isArray(v)) return { error: "The sample must be a JSON object." };
    return { obj: v };
  } catch (e) {
    return { error: `Not valid JSON: ${(e as Error).message}` };
  }
}

/** The sample as a tree; leaves are buttons that map the picked field to that path. */
function SampleTree({
  value,
  prefix,
  mapped,
  picking,
  onPick,
}: {
  value: Json[] | { [k: string]: Json };
  prefix: string;
  mapped: Set<string>;
  picking: boolean;
  onPick: (path: string) => void;
}) {
  const entries: [string, Json][] = Array.isArray(value) ? value.map((v, i) => [String(i), v]) : Object.entries(value);
  return (
    <ul className="sx-tree" aria-label={prefix === "" ? "Sample fields" : undefined}>
      {entries.map(([k, v]) => {
        const path = prefix ? `${prefix}.${k}` : k;
        if (v !== null && typeof v === "object")
          return (
            <li key={k}>
              <span className="sx-key">{k}</span>
              <SampleTree value={v} prefix={path} mapped={mapped} picking={picking} onPick={onPick} />
            </li>
          );
        return (
          <li key={k}>
            <button
              type="button"
              className={`sx-leaf${mapped.has(path) ? " mapped" : ""}${picking ? " picking" : ""}`}
              aria-label={`Map field ${path}`}
              title={picking ? `Use ${path}` : path}
              onClick={() => onPick(path)}
            >
              <span className="sx-leaf-key">{k}</span>
              <span className="sx-leaf-val">{JSON.stringify(v)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function ValueMap({ field, value, onChange }: { field: string; value: Record<string, string>; onChange: (v: Record<string, string> | undefined) => void }) {
  const entries = Object.entries(value);
  const commit = (next: [string, string][]) => onChange(next.length ? Object.fromEntries(next) : undefined);
  return (
    <div className="sx-vmap" role="group" aria-label={`Value map for ${field}`}>
      <span className="field-label">Translate values</span>
      {entries.map(([from, to], i) => (
        <div className="sx-vmap-row" key={i}>
          <input
            type="text"
            className="mono"
            aria-label={`${field} value map from ${i + 1}`}
            placeholder="P1"
            value={from}
            onChange={(e) => {
              const k = e.target.value;
              if (k !== from && Object.hasOwn(value, k)) return;
              commit(entries.map((p, j): [string, string] => (j === i ? [k, to] : p)));
            }}
          />
          <span aria-hidden="true" className="muted">
            becomes
          </span>
          <input
            type="text"
            className="mono"
            aria-label={`${field} value map to ${i + 1}`}
            placeholder="critical"
            value={to}
            onChange={(e) => commit(entries.map((p, j): [string, string] => (j === i ? [from, e.target.value] : p)))}
          />
          <button type="button" className="icon-btn" aria-label={`Remove value map pair ${i + 1} of ${field}`} onClick={() => commit(entries.filter((_, j) => j !== i))}>
            <Icon as={X} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="link-btn"
        aria-label={`Add value map pair to ${field}`}
        disabled={Object.hasOwn(value, "")}
        onClick={() => commit([...entries, ["", ""]])}
      >
        <Plus size={12} aria-hidden="true" /> Add a translation
      </button>
    </div>
  );
}

/** One alert field: how it's filled, the live result, and (expanded) default + value map. */
function MappingRow({
  name,
  required,
  hint,
  mapping,
  result,
  picking,
  onPickStart,
  onChange,
}: {
  name: CommonFieldName;
  required: boolean;
  hint: string;
  mapping: FieldMapping | undefined;
  result: string | undefined;
  picking: boolean;
  onPickStart: () => void;
  onChange: (m: FieldMapping | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const extras = mapping ? { valueMap: mapping.valueMap, default: mapping.default } : {};
  const kind: MappingKind | null = mapping?.kind ?? null;
  const text = !mapping ? "" : mapping.kind === "path" ? mapping.path : mapping.kind === "constant" ? mapping.value : mapping.template;
  const setKind = (k: MappingKind) =>
    onChange(k === "path" ? { kind: k, path: "", ...extras } : k === "constant" ? { kind: k, value: "", ...extras } : { kind: k, template: "", ...extras });
  const setText = (v: string) =>
    mapping &&
    onChange(mapping.kind === "path" ? { ...mapping, path: v } : mapping.kind === "constant" ? { ...mapping, value: v } : { ...mapping, template: v });
  const advanced = mapping && (mapping.default || (mapping.valueMap && Object.keys(mapping.valueMap).length));

  return (
    <div className={`sx-row${picking ? " picking" : ""}${mapping ? "" : " unmapped"}`} role="group" aria-label={`Mapping for ${name}`}>
      <div className="sx-row-main">
        <div className="sx-name">
          <span className="mono">{name}</span>
          <span className="sx-hint" title={hint}>
            {required && <span className="sx-req">Recommended · </span>}
            {hint}
          </span>
        </div>
        {mapping ? (
          <div className="sx-source">
            <div className="segmented-sm" role="radiogroup" aria-label={`Kind for ${name}`}>
              {(["path", "constant", "template"] as const).map((k) => (
                <button key={k} type="button" role="radio" aria-checked={kind === k} className={kind === k ? "seg on" : "seg"} onClick={() => k !== kind && setKind(k)}>
                  {KIND_LABEL[k]}
                </button>
              ))}
            </div>
            <input
              type="text"
              className="mono sx-input"
              spellCheck={false}
              aria-label={`${mapping.kind === "path" ? "Path" : mapping.kind === "constant" ? "Value" : "Template"} for ${name}`}
              placeholder={PLACEHOLDER[mapping.kind]}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            {mapping.kind === "path" && (
              <button
                type="button"
                className={picking ? "icon-btn sx-pick on" : "icon-btn sx-pick"}
                aria-pressed={picking}
                aria-label={picking ? `Click a field in the sample for ${name}` : `Pick ${name} from the sample`}
                title={picking ? "Now click a field in the sample" : "Pick from the sample"}
                onClick={onPickStart}
              >
                <Icon as={MousePointerClick} />
              </button>
            )}
          </div>
        ) : (
          <div className="sx-source">
            <button
              type="button"
              className="btn"
              onClick={() => {
                onChange({ kind: "path", path: "" });
                onPickStart();
              }}
            >
              <Plus size={14} aria-hidden="true" /> Map {name}
            </button>
          </div>
        )}
        <div className={result !== undefined ? "sx-result has" : "sx-result"} title={result}>
          {result !== undefined ? result : mapping ? "no value" : "—"}
        </div>
        <div className="sx-tools">
          {mapping && (
            <>
              <button
                type="button"
                className={advanced ? "icon-btn on" : "icon-btn"}
                aria-expanded={open}
                aria-label={`More options for ${name}`}
                title="Default and value translations"
                onClick={() => setOpen((v) => !v)}
              >
                <Icon as={open ? ChevronDown : ChevronRight} />
              </button>
              <button type="button" className="icon-btn" aria-label={`Remove mapping for ${name}`} onClick={() => onChange(undefined)}>
                <Icon as={Trash2} />
              </button>
            </>
          )}
        </div>
      </div>
      {open && mapping && (
        <div className="sx-more">
          <label className="field">
            Default when missing
            <input
              type="text"
              className="mono"
              aria-label={`Default for ${name}`}
              value={mapping.default ?? ""}
              onChange={(e) => onChange({ ...mapping, default: e.target.value === "" ? undefined : e.target.value })}
            />
          </label>
          <ValueMap field={name} value={mapping.valueMap ?? {}} onChange={(valueMap) => onChange({ ...mapping, valueMap })} />
        </div>
      )}
    </div>
  );
}

export function SchemaEditor({
  initial,
  initialMatch,
  isNew,
  sample: initialSample = "",
  tabs,
  notice,
}: {
  initial: Schema;
  initialMatch: string;
  isNew: boolean;
  sample?: string;
  tabs?: ReactNode;
  notice?: string;
}) {
  const navigate = useNavigate();
  const [schema, setSchema] = useState<Schema>(initial);
  const [match, setMatch] = useState(initialMatch);
  // No hand-written rule: write it from the sample and the mapping (see generateMatch).
  const [autoMatch, setAutoMatch] = useState(initialMatch.trim() === "");
  const [idTouched, setIdTouched] = useState(!isNew || initial.id !== "");
  // The sample saved with the schema wins; examples pass theirs in.
  const [sampleText, setSampleText] = useState(initial.sample ?? initialSample);
  const [picking, setPicking] = useState<CommonFieldName | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [idError, setIdError] = useState("");
  const [yaml, setYaml] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const sample = useMemo(() => parseSample(sampleText), [sampleText]);
  const generated = useMemo(() => generateMatch(sample.obj, schema.mapping), [sample.obj, schema.mapping]);
  const effectiveMatch = autoMatch ? generated : match;
  const test = useMemo(() => testSchema(schema, effectiveMatch, sample.obj), [schema, effectiveMatch, sample.obj]);

  const patch = (p: Partial<Schema>) => setSchema((s) => ({ ...s, ...p }));
  const setMapping = (name: CommonFieldName, m: FieldMapping | undefined) =>
    setSchema((s) => {
      const mapping = { ...s.mapping };
      if (m) mapping[name] = m;
      else delete mapping[name];
      return { ...s, mapping };
    });
  const pick = (path: string) => {
    if (!picking) return;
    const prev = schema.mapping[picking];
    setMapping(picking, { kind: "path", path, valueMap: prev?.valueMap, default: prev?.default });
    setPicking(null);
  };

  const mappedPaths = new Set(Object.values(schema.mapping).flatMap((m) => (m.kind === "path" ? [m.path] : [])));
  const mappedCount = COMMON_FIELDS.filter((f) => schema.mapping[f.name]).length;
  const missing = COMMON_FIELDS.filter((f) => f.required && !schema.mapping[f.name]).map((f) => f.name);
  const ordered = [...COMMON_FIELDS].sort((a, b) => Number(b.required) - Number(a.required));

  async function save() {
    let idErr = "";
    if (isNew) {
      if (!ID_RE.test(schema.id)) idErr = "Use letters, digits, dash or underscore.";
      else if (RESERVED_IDS.includes(schema.id)) idErr = `"${schema.id}" is reserved. Choose another id.`;
    }
    setIdError(idErr);
    const problems: string[] = [];
    if (schema.name.trim() === "") problems.push("Name is required.");
    if (idErr) problems.push(idErr);
    if (test.matchError) problems.push("Fix the rule under Advanced: " + test.matchError);
    if (effectiveMatch.trim() === "")
      problems.push("Paste a sample event (or write a rule under Advanced), so this schema isn't used for every event.");
    setErrors(problems);
    if (problems.length) return;
    setBusy(true);
    try {
      const body = cleanSchema(schema, effectiveMatch, sampleText);
      if (isNew) await sendJson<Schema>("POST", "/api/schemas", body);
      else await sendJson<Schema>("PUT", `/api/schemas/${encodeURIComponent(schema.id)}`, body);
      navigate("/config/schemas");
    } catch (e) {
      setErrors([(e as Error).message]);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Delete schema "${schema.name}"? Matching events will no longer be mapped.`)) return;
    try {
      await sendJson<unknown>("DELETE", `/api/schemas/${encodeURIComponent(schema.id)}`);
      navigate("/config/schemas");
    } catch (e) {
      setErrors([(e as Error).message]);
    }
  }

  async function exportYaml() {
    try {
      const text = await getText(`/api/schemas/${encodeURIComponent(schema.id)}/export`);
      setYaml(text);
      const url = URL.createObjectURL(new Blob([text], { type: "application/yaml" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `${schema.id}.yaml`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (e) {
      setErrors([(e as Error).message]);
    }
  }

  const sev = test.common.severity ?? "info";

  return (
    <main className="page sx-page re-page">
      <header className="page-header">
        <div>
          <h1>{isNew ? "New schema" : schema.name || "Edit schema"}</h1>
          <p className="page-intro">{isNew ? SCHEMA_INTRO : `Schema id ${schema.id}`}</p>
        </div>
      </header>
      {tabs}
      {notice && <p className="callout info">{notice}</p>}

      <div className="re-layout">
        <div className="re-steps">
          <Step n={1} title="Name and id" help="A name for the kind of event, e.g. the system that sends it.">
            <div className="re-grid-2">
              <label className="field">
                Name
                <input
                  type="text"
                  value={schema.name}
                  placeholder="Datadog monitor"
                  onChange={(e) => patch(idTouched ? { name: e.target.value } : { name: e.target.value, id: slugify(e.target.value) })}
                />
              </label>
              <div className="field">
                <label htmlFor="sx-id">Id</label>
                <input
                  id="sx-id"
                  type="text"
                  className="mono"
                  value={schema.id}
                  readOnly={!isNew}
                  aria-invalid={idError ? true : undefined}
                  onChange={(e) => {
                    setIdTouched(true);
                    patch({ id: e.target.value });
                  }}
                />
                {idError && <span className="sx-error">{idError}</span>}
              </div>
            </div>
          </Step>

          <Step n={2} title="Sample event" help="Paste one real event as JSON. Everything below is checked against it as you type, and it is saved with the schema.">
            <label className="field">
              Sample event (JSON)
              <textarea
                className="mono sx-sample"
                spellCheck={false}
                rows={6}
                placeholder='{"alertname": "HighErrorRate", "labels": {"service": "payments-api"}}'
                aria-invalid={sample.error ? true : undefined}
                value={sampleText}
                onChange={(e) => setSampleText(e.target.value)}
              />
            </label>
            {sample.error && <span className="sx-error">{sample.error}</span>}
          </Step>

          <Step n={3} title="Map to alert fields" help="Fill alert fields from the event: a field, a fixed value or a template. None are mandatory; unmapped fields stay empty and severity falls back to info.">
            <div className={sample.obj ? "sx-map-layout with-sample" : "sx-map-layout"}>
              <div className="sx-rows" aria-label="Field mappings">
                <div className="sx-row-head" aria-hidden="true">
                  <span>Alert field</span>
                  <span>Filled from</span>
                  <span>Value for the sample</span>
                  <span />
                </div>
                {ordered.map((f) => (
                  <MappingRow
                    key={f.name}
                    name={f.name}
                    required={f.required}
                    hint={f.hint}
                    mapping={schema.mapping[f.name]}
                    result={test.common[f.name]}
                    picking={picking === f.name}
                    onPickStart={() => setPicking((p) => (p === f.name ? null : f.name))}
                    onChange={(m) => setMapping(f.name, m)}
                  />
                ))}
              </div>
              {sample.obj && (
                <aside className="sx-sample-panel" aria-label="Sample event">
                  <div className="sx-sample-head">
                    {picking ? (
                      <>
                        Click a field for <span className="mono">{picking}</span>
                        <button type="button" className="link-btn" onClick={() => setPicking(null)}>
                          Cancel
                        </button>
                      </>
                    ) : (
                      "Sample fields"
                    )}
                  </div>
                  <SampleTree value={sample.obj} prefix="" mapped={mappedPaths} picking={picking !== null} onPick={pick} />
                </aside>
              )}
            </div>
          </Step>

          <details className="sx-advanced" open={!autoMatch}>
            <summary>Advanced: which events use this schema</summary>
            <p className="re-help">
              Each event is mapped by the first schema (by id) whose rule it passes. The rule is written for you from the
              sample and the mapping; write your own only if two kinds of events look alike.
            </p>
            {autoMatch ? (
              <>
                <code className="sx-rule">{generated || "Paste a sample event to generate the rule."}</code>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setMatch(generated);
                    setAutoMatch(false);
                  }}
                >
                  Write my own rule
                </button>
              </>
            ) : (
              <>
                <MatchFilterInput value={match} onChange={setMatch} />
                <button type="button" className="btn" onClick={() => setAutoMatch(true)}>
                  Generate it from the sample instead
                </button>
              </>
            )}
            {test.matched !== null && (
              <span className={test.matched ? "sx-badge yes" : "sx-badge no"} role="status">
                <Icon as={test.matched ? Check : X} /> {test.matched ? "The sample passes the rule" : "The sample doesn't pass the rule"}
              </span>
            )}
          </details>

          {yaml !== null && (
            <pre className="code-block" aria-label="Exported YAML">
              {yaml}
            </pre>
          )}
        </div>

        <aside className="re-summary" aria-label="Schema summary">
          <h2>Summary</h2>
          <p className="re-sentence">
            {!effectiveMatch.trim() ? (
              <>Paste a sample event so the schema knows which events it is for.</>
            ) : autoMatch && describeMatch(effectiveMatch) ? (
              <>Used for {describeMatch(effectiveMatch)}</>
            ) : (
              <>
                Used for events matching <code>{effectiveMatch.trim()}</code>
              </>
            )}
            . Fills {mappedCount} of {COMMON_FIELDS.length} alert fields.
            {missing.length > 0 && <> Recommended but not mapped: {missing.join(", ")}.</>}
          </p>
          <div className="sx-preview" aria-label="Alert preview">
            <div className="sx-preview-caption">{sample.obj ? "The sample as an alert" : "Paste a sample to preview the alert"}</div>
            {sample.obj && (
              <>
                <div className={`sx-preview-row sev-${sev}`}>
                  <span className="sev-label">{SEV_SHORT[sev] ?? sev}</span>
                  <span className="sx-preview-title">{test.common.title ?? "No title mapped"}</span>
                </div>
                <dl className="re-facts sx-preview-facts">
                  {(["source", "environment", "sourceStatus", "occurredAt", "dedupKey"] as const).map((k) => (
                    <div key={k}>
                      <dt>{k}</dt>
                      <dd>{test.common[k] ?? "—"}</dd>
                    </div>
                  ))}
                </dl>
              </>
            )}
          </div>
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
        <Link className="btn" to="/config/schemas">
          {isNew ? "Cancel" : "Back to schemas"}
        </Link>
        {!isNew && (
          <>
            <button type="button" className="btn" onClick={exportYaml}>
              <Icon as={Download} /> Export YAML
            </button>
            <button type="button" className="btn danger" onClick={remove}>
              <Icon as={Trash2} /> Delete
            </button>
          </>
        )}
        <button type="button" className="btn primary" disabled={busy} onClick={save}>
          Save schema
        </button>
      </footer>
    </main>
  );
}
