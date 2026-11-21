import { Download, Plus, Trash2, Upload } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Icon } from "../../components/Icon";
import { getJson, getText, sendJson, sendText } from "../sources/api";
import "../sources/sources.css";
import { MatchFilterInput } from "./MatchFilterInput";
import "./schemas.css";
import {
  COMMON_FIELDS,
  RESERVED_IDS,
  type CommonFieldName,
  type CommonFields,
  type FieldMapping,
  type MappingKind,
  type Schema,
} from "./types";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const TEMPLATE_HINT =
  "Use {{path}} to insert a field, for example {{error.code}}: {{error.message}}. If a field is missing the default is used.";

export function SchemasListPage() {
  const [schemas, setSchemas] = useState<Schema[] | null>(null);
  const [error, setError] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [yaml, setYaml] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    getJson<Schema[]>("/api/schemas").then(setSchemas, (e: Error) =>
      setError(e.message),
    );
  }, []);
  useEffect(load, [load]);

  const doImport = async () => {
    setBusy(true);
    setError("");
    try {
      await sendText<Schema>(
        "POST",
        "/api/schemas/import",
        yaml,
        "application/yaml",
      );
      setYaml("");
      setImportOpen(false);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page">
      <Link to="/">← Back to alerts</Link>
      <div className="src-head">
        <h1>Schemas</h1>
        <button
          type="button"
          className="btn"
          onClick={() => setImportOpen((o) => !o)}
        >
          <Icon as={Upload} /> Import YAML
        </button>
        <Link
          to="/config/schemas/new"
          className="btn primary"
          style={{ textDecoration: "none" }}
        >
          <Icon as={Plus} /> Add schema
        </Link>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {importOpen && (
        <section className="cfg-panel" aria-label="Import schema">
          <div className="field">
            <label htmlFor="import-yaml">Schema YAML</label>
            <textarea
              id="import-yaml"
              value={yaml}
              onChange={(e) => setYaml(e.target.value)}
            />
          </div>
          <div className="actions">
            <input
              type="file"
              accept=".yaml,.yml,text/yaml,application/yaml"
              aria-label="YAML file"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) setYaml(await f.text());
              }}
            />
            <button
              type="button"
              className="btn primary"
              disabled={busy || yaml.trim() === ""}
              onClick={doImport}
            >
              Import
            </button>
          </div>
        </section>
      )}
      {schemas === null && !error && <p className="muted">Loading…</p>}
      {schemas?.length === 0 && <p className="muted">No schemas yet.</p>}
      {schemas && schemas.length > 0 && (
        <ul className="src-list" aria-label="Schemas">
          {schemas.map((s) => (
            <li key={s.id}>
              <div className="grow">
                <Link to={`/config/schemas/${encodeURIComponent(s.id)}`}>
                  {s.name}
                </Link>
                <div className="muted mono">{s.id}</div>
              </div>
              <span className="badge">
                {Object.keys(s.mapping).length} mapped fields
              </span>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

/* ---------- sample tree ---------- */

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

function isContainer(v: Json): v is Json[] | { [k: string]: Json } {
  return v !== null && typeof v === "object";
}

function SampleTree({
  value,
  prefix,
  mappedPaths,
  onPick,
  root,
}: {
  value: Json[] | { [k: string]: Json };
  prefix: string;
  mappedPaths: Set<string>;
  onPick: (path: string) => void;
  root?: boolean;
}) {
  const entries: [string, Json][] = Array.isArray(value)
    ? value.map((v, i) => [String(i), v])
    : Object.entries(value);
  return (
    <ul
      className={root ? "sch-tree root" : "sch-tree"}
      aria-label={root ? "Sample fields" : undefined}
    >
      {entries.map(([k, v]) => {
        const path = prefix ? `${prefix}.${k}` : k;
        if (isContainer(v)) {
          return (
            <li key={k}>
              <span className="sch-key">{k}</span>
              <SampleTree
                value={v}
                prefix={path}
                mappedPaths={mappedPaths}
                onPick={onPick}
              />
            </li>
          );
        }
        return (
          <li key={k}>
            <button
              type="button"
              className={mappedPaths.has(path) ? "sch-leaf mapped" : "sch-leaf"}
              aria-label={`Map field ${path}`}
              title={`Click to map ${path}`}
              onClick={() => onPick(path)}
            >
              <span>{k}</span>
              <span className="val">{JSON.stringify(v)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/* ---------- mapping row ---------- */

function ValueMapEditor({
  field,
  value,
  onChange,
}: {
  field: string;
  value: Record<string, string>;
  onChange: (v: Record<string, string> | undefined) => void;
}) {
  const entries = Object.entries(value);
  const commit = (next: [string, string][]) =>
    onChange(next.length ? Object.fromEntries(next) : undefined);
  return (
    <div className="field" role="group" aria-label={`Value map for ${field}`}>
      <span className="hint">
        Value map: translate source values (from) into common values (to).
      </span>
      {entries.map(([from, to], i) => (
        <div className="cfg-row" key={i}>
          <input
            type="text"
            aria-label={`${field} value map from ${i + 1}`}
            value={from}
            onChange={(e) => {
              const k = e.target.value;
              if (k !== from && Object.hasOwn(value, k)) return;
              commit(
                entries.map((p, j): [string, string] =>
                  j === i ? [k, to] : p,
                ),
              );
            }}
          />
          <span aria-hidden="true">→</span>
          <input
            type="text"
            aria-label={`${field} value map to ${i + 1}`}
            value={to}
            onChange={(e) =>
              commit(
                entries.map((p, j): [string, string] =>
                  j === i ? [from, e.target.value] : p,
                ),
              )
            }
          />
          <button
            type="button"
            className="btn"
            aria-label={`Remove value map pair ${i + 1} of ${field}`}
            onClick={() => commit(entries.filter((_, j) => j !== i))}
          >
            <Icon as={Trash2} />
          </button>
        </div>
      ))}
      <div className="actions">
        <button
          type="button"
          className="btn"
          aria-label={`Add value map pair to ${field}`}
          disabled={Object.hasOwn(value, "")}
          onClick={() => commit([...entries, ["", ""]])}
        >
          <Icon as={Plus} /> Add pair
        </button>
      </div>
    </div>
  );
}

function MappingRow({
  name,
  required,
  hint,
  mapping,
  active,
  onActivate,
  onChange,
  onRemove,
}: {
  name: CommonFieldName;
  required: boolean;
  hint: string;
  mapping: FieldMapping;
  active: boolean;
  onActivate: () => void;
  onChange: (m: FieldMapping) => void;
  onRemove: () => void;
}) {
  const extras = { valueMap: mapping.valueMap, default: mapping.default };
  const setKind = (kind: MappingKind) => {
    if (kind === mapping.kind) return;
    onChange(
      kind === "path"
        ? { kind, path: "", ...extras }
        : kind === "constant"
          ? { kind, value: "", ...extras }
          : { kind, template: "", ...extras },
    );
  };
  const main =
    mapping.kind === "path"
      ? { label: "Path", value: mapping.path }
      : mapping.kind === "constant"
        ? { label: "Value", value: mapping.value }
        : { label: "Template", value: mapping.template };
  const setMain = (v: string) =>
    onChange(
      mapping.kind === "path"
        ? { ...mapping, path: v }
        : mapping.kind === "constant"
          ? { ...mapping, value: v }
          : { ...mapping, template: v },
    );
  return (
    <div
      className={active ? "sch-map active" : "sch-map"}
      role="group"
      aria-label={`Mapping for ${name}`}
    >
      <h3>
        <span className="mono">{name}</span>
        {required && (
          <span className="req" title="Required common field">
            *
          </span>
        )}
        <span className="hint" style={{ flex: 1, fontWeight: "normal" }}>
          {hint}
        </span>
        <button
          type="button"
          className="btn"
          aria-pressed={active}
          onClick={onActivate}
        >
          {active ? "Click a field in the sample" : "Pick from sample"}
        </button>
        <button
          type="button"
          className="btn"
          aria-label={`Remove mapping for ${name}`}
          onClick={onRemove}
        >
          <Icon as={Trash2} />
        </button>
      </h3>
      <div className="cfg-row">
        <select
          aria-label={`Kind for ${name}`}
          value={mapping.kind}
          onChange={(e) => setKind(e.target.value as MappingKind)}
        >
          <option value="path">Field from event (path)</option>
          <option value="constant">Fixed value</option>
          <option value="template">Template</option>
        </select>
        <input
          type="text"
          className="mono"
          spellCheck={false}
          aria-label={`${main.label} for ${name}`}
          value={main.value}
          onChange={(e) => setMain(e.target.value)}
        />
      </div>
      {mapping.kind === "template" && (
        <span className="hint">{TEMPLATE_HINT}</span>
      )}
      <div className="cfg-row">
        <label htmlFor={`default-${name}`} className="hint">
          Default
        </label>
        <input
          id={`default-${name}`}
          type="text"
          value={mapping.default ?? ""}
          aria-label={`Default for ${name}`}
          onChange={(e) =>
            onChange({
              ...mapping,
              default: e.target.value === "" ? undefined : e.target.value,
            })
          }
        />
      </div>
      <ValueMapEditor
        field={name}
        value={mapping.valueMap ?? {}}
        onChange={(valueMap) => onChange({ ...mapping, valueMap })}
      />
    </div>
  );
}

/* ---------- edit page ---------- */

function blank(): Schema {
  return { id: "", name: "", match: "", mapping: {} };
}

/** Drop empty value-map keys and empty defaults before saving/testing. */
function clean(s: Schema, match: string): Schema {
  const mapping: Schema["mapping"] = {};
  for (const [k, m] of Object.entries(s.mapping) as [
    CommonFieldName,
    FieldMapping,
  ][]) {
    const out: FieldMapping = { ...m };
    if (out.valueMap) {
      const vm = Object.fromEntries(
        Object.entries(out.valueMap).filter(([from]) => from !== ""),
      );
      if (Object.keys(vm).length) out.valueMap = vm;
      else delete out.valueMap;
    }
    if (out.default === undefined || out.default === "") delete out.default;
    mapping[k] = out;
  }
  return { ...s, match, mapping };
}

function parseSample(text: string): {
  obj?: { [k: string]: Json };
  error?: string;
} {
  if (text.trim() === "") return {};
  try {
    const v = JSON.parse(text) as Json;
    if (v === null || typeof v !== "object" || Array.isArray(v))
      return { error: "The sample must be a JSON object." };
    return { obj: v };
  } catch (e) {
    return { error: `Not valid JSON: ${(e as Error).message}` };
  }
}

function useTest(
  schema: Schema | null,
  match: string,
  sample: { [k: string]: Json } | undefined,
) {
  const [state, setState] = useState<{
    matched?: boolean;
    common?: CommonFields;
    error?: string;
  }>({});
  const key = JSON.stringify([schema && clean(schema, match), sample]);
  useEffect(() => {
    if (!schema || !sample) {
      setState({});
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      sendJson<{ matched: boolean; common: CommonFields }>(
        "POST",
        "/api/schemas/test",
        {
          schema: clean(schema, match),
          sample,
        },
      ).then(
        (r) => live && setState({ matched: r.matched, common: r.common }),
        (e: Error) => live && setState({ error: e.message }),
      );
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [key]);
  return state;
}

export function SchemaEditPage() {
  const { id } = useParams();
  return <SchemaEditForm key={id} />;
}

function SchemaEditForm() {
  const { id: routeId } = useParams();
  const isNew = routeId === "new";
  const navigate = useNavigate();
  const [schema, setSchema] = useState<Schema | null>(isNew ? blank() : null);
  const [match, setMatch] = useState("");
  const [error, setError] = useState("");
  const [idError, setIdError] = useState("");
  const [sampleText, setSampleText] = useState("");
  const [active, setActive] = useState<CommonFieldName | null>(null);
  const [addField, setAddField] = useState("");
  const [yaml, setYaml] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (isNew || !routeId) return;
    let live = true;
    getJson<Schema>(`/api/schemas/${encodeURIComponent(routeId)}`).then(
      async (s) => {
        let text = "";
        if (typeof s.match === "string") text = s.match;
        else {
          try {
            text = (
              await sendJson<{ text: string }>("POST", "/api/filters/format", {
                tree: s.match,
              })
            ).text;
          } catch {
            text = "";
          }
        }
        if (!live) return;
        setMatch(text);
        setSchema(s);
      },
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [isNew, routeId]);

  const sample = useMemo(() => parseSample(sampleText), [sampleText]);
  const test = useTest(schema, match, sample.obj);

  if (!schema) {
    return (
      <main className="page">
        <Link to="/config/schemas">← Back to schemas</Link>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : (
          <p className="muted">Loading…</p>
        )}
      </main>
    );
  }

  const patch = (p: Partial<Schema>) => setSchema({ ...schema, ...p });
  const setMapping = (name: CommonFieldName, m: FieldMapping | undefined) => {
    const mapping = { ...schema.mapping };
    if (m) mapping[name] = m;
    else delete mapping[name];
    patch({ mapping });
  };
  const ensure = (name: CommonFieldName) => {
    if (!schema.mapping[name]) setMapping(name, { kind: "path", path: "" });
    setActive(name);
  };
  const pick = (path: string) => {
    if (!active) {
      setError(
        "Choose a common field first, then click a field in the sample.",
      );
      return;
    }
    setError("");
    const prev = schema.mapping[active];
    setMapping(active, {
      kind: "path",
      path,
      valueMap: prev?.valueMap,
      default: prev?.default,
    });
  };

  const mappedPaths = new Set(
    Object.values(schema.mapping).flatMap((m) =>
      m.kind === "path" ? [m.path] : [],
    ),
  );
  const unmapped = COMMON_FIELDS.filter((f) => !schema.mapping[f.name]);

  const save = async () => {
    setError("");
    let idErr = "";
    if (isNew) {
      if (!ID_RE.test(schema.id))
        idErr = "Use letters, digits, dash or underscore.";
      else if (RESERVED_IDS.includes(schema.id))
        idErr = `"${schema.id}" is reserved. Choose another id.`;
    }
    setIdError(idErr);
    if (schema.name.trim() === "") return setError("Name is required.");
    if (idErr) return;
    const body = clean(schema, match);
    setBusy(true);
    try {
      if (isNew) await sendJson<Schema>("POST", "/api/schemas", body);
      else
        await sendJson<Schema>(
          "PUT",
          `/api/schemas/${encodeURIComponent(schema.id)}`,
          body,
        );
      navigate("/config/schemas");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Delete schema "${schema.name}"?`)) return;
    try {
      await sendJson<unknown>(
        "DELETE",
        `/api/schemas/${encodeURIComponent(schema.id)}`,
      );
      navigate("/config/schemas");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const exportYaml = async () => {
    try {
      const text = await getText(
        `/api/schemas/${encodeURIComponent(schema.id)}/export`,
      );
      setYaml(text);
      const url = URL.createObjectURL(
        new Blob([text], { type: "application/yaml" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = `${schema.id}.yaml`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const mappedFields = COMMON_FIELDS.filter((f) => schema.mapping[f.name]);

  return (
    <main className="page">
      <Link to="/config/schemas">← Back to schemas</Link>
      <div className="src-head">
        <h1>{isNew ? "Add schema" : "Edit schema"}</h1>
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
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {yaml && (
        <pre className="preview" aria-label="Exported YAML">
          {yaml}
        </pre>
      )}

      <section className="cfg-panel" aria-label="Schema settings">
        <div className="field">
          <label htmlFor="sch-id">Id</label>
          <input
            id="sch-id"
            type="text"
            value={schema.id}
            readOnly={!isNew}
            aria-invalid={idError ? true : undefined}
            onChange={(e) => patch({ id: e.target.value })}
          />
          {idError && (
            <span className="field-error" role="alert">
              {idError}
            </span>
          )}
        </div>
        <div className="field">
          <label htmlFor="sch-name">Name</label>
          <input
            id="sch-name"
            type="text"
            value={schema.name}
            onChange={(e) => patch({ name: e.target.value })}
          />
        </div>
        <MatchFilterInput value={match} onChange={setMatch} />
      </section>

      <div className="sch-grid">
        <section className="cfg-panel" aria-label="Sample event">
          <div className="field">
            <label htmlFor="sch-sample">Sample event (JSON)</label>
            <textarea
              id="sch-sample"
              value={sampleText}
              spellCheck={false}
              placeholder="Paste a real event here, then click its fields to map them"
              aria-invalid={sample.error ? true : undefined}
              onChange={(e) => setSampleText(e.target.value)}
              style={{ minHeight: 140 }}
            />
            {sample.error && (
              <span className="field-error" role="alert">
                {sample.error}
              </span>
            )}
          </div>
          {sample.obj && (
            <>
              <p className="hint">
                {active
                  ? `Click a field below to map it to ${active}.`
                  : "Choose a common field on the right, then click a field below."}
              </p>
              <SampleTree
                value={sample.obj}
                prefix=""
                mappedPaths={mappedPaths}
                onPick={pick}
                root
              />
            </>
          )}
        </section>

        <section className="cfg-panel" aria-label="Field mappings">
          <h2>Common fields</h2>
          <div className="field">
            <label htmlFor="sch-add-field">Common field to map</label>
            <select
              id="sch-add-field"
              value={addField}
              onChange={(e) => {
                const v = e.target.value as CommonFieldName | "";
                setAddField("");
                if (v) ensure(v);
              }}
            >
              <option value="">Choose a common field…</option>
              {unmapped.map((f) => (
                <option key={f.name} value={f.name}>
                  {f.name}
                  {f.required ? " (required)" : " (optional)"}
                </option>
              ))}
            </select>
            <span className="hint">
              Fields you leave unmapped stay empty; severity falls back to info.
            </span>
          </div>
          {mappedFields.length === 0 && (
            <p className="muted">No fields mapped yet.</p>
          )}
          {mappedFields.map((f) => (
            <MappingRow
              key={f.name}
              name={f.name}
              required={f.required}
              hint={f.hint}
              mapping={schema.mapping[f.name]!}
              active={active === f.name}
              onActivate={() => setActive(active === f.name ? null : f.name)}
              onChange={(m) => setMapping(f.name, m)}
              onRemove={() => {
                setMapping(f.name, undefined);
                if (active === f.name) setActive(null);
              }}
            />
          ))}
        </section>
      </div>

      <section className="cfg-panel" aria-label="Test result">
        <h2>Test result</h2>
        {!sample.obj && (
          <p className="muted">Paste a sample event to see how it maps.</p>
        )}
        {test.error && (
          <p className="form-error" role="alert">
            {test.error}
          </p>
        )}
        {test.matched !== undefined && (
          <>
            <p>
              Matches:{" "}
              <span className={test.matched ? "sch-yes" : "sch-no"}>
                {test.matched ? "yes" : "no"}
              </span>
            </p>
            <table className="sch-result" aria-label="Mapped common fields">
              <thead>
                <tr>
                  <th scope="col">Common field</th>
                  <th scope="col">Value</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(test.common ?? {}).map(([k, v]) => (
                  <tr key={k}>
                    <th scope="row">{k}</th>
                    <td>{String(v)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>

      <div className="actions">
        <button
          type="button"
          className="btn primary"
          disabled={busy}
          onClick={save}
        >
          Save
        </button>
        <Link
          to="/config/schemas"
          className="btn"
          style={{ textDecoration: "none" }}
        >
          Cancel
        </Link>
      </div>
    </main>
  );
}
