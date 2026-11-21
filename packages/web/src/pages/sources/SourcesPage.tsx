import { Download, Plus, Trash2, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Icon } from "../../components/Icon";
import { getJson, getText, sendJson, sendText } from "./api";
import { SchemaForm, validateConfig } from "./SchemaForm";
import {
  RESERVED_IDS,
  sourceTypeLabel,
  type JsonSchemaObject,
  type ParserConfig,
  type Source,
  type SourceTypesResponse,
} from "./sourceTypes";
import "./sources.css";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function SourcesListPage() {
  const [sources, setSources] = useState<Source[] | null>(null);
  const [error, setError] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [yaml, setYaml] = useState("");
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    getJson<Source[]>("/api/sources").then(setSources, (e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const doImport = async () => {
    setBusy(true);
    setError("");
    try {
      await sendText<Source>("POST", "/api/sources/import", yaml, "application/yaml");
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
        <h1>Sources</h1>
        <button type="button" className="btn" onClick={() => setImportOpen((o) => !o)}>
          <Icon as={Upload} /> Import YAML
        </button>
        <Link to="/config/sources/new" className="btn primary" style={{ textDecoration: "none" }}>
          <Icon as={Plus} /> Add source
        </Link>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {importOpen && (
        <section className="cfg-panel" aria-label="Import source">
          <div className="field">
            <label htmlFor="import-yaml">Source YAML</label>
            <textarea id="import-yaml" value={yaml} onChange={(e) => setYaml(e.target.value)} />
          </div>
          <div className="actions">
            <input
              ref={fileInput}
              type="file"
              accept=".yaml,.yml,text/yaml,application/yaml"
              aria-label="YAML file"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) setYaml(await f.text());
              }}
            />
            <button type="button" className="btn primary" disabled={busy || yaml.trim() === ""} onClick={doImport}>
              Import
            </button>
          </div>
        </section>
      )}
      {sources === null && !error && <p className="muted">Loading…</p>}
      {sources?.length === 0 && <p className="muted">No sources yet.</p>}
      {sources && sources.length > 0 && (
        <ul className="src-list" aria-label="Sources">
          {sources.map((s) => (
            <li key={s.id}>
              <div className="grow">
                <Link to={`/config/sources/${encodeURIComponent(s.id)}`}>{s.name}</Link>
                <div className="muted mono">{s.id}</div>
              </div>
              <span className="badge">{sourceTypeLabel(s.type)}</span>
              <span className="badge">{s.parser.type}</span>
              <span className={s.enabled ? "badge on" : "badge"}>{s.enabled ? "Enabled" : "Disabled"}</span>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

/** Fetches GET /api/source-types once; `reload` retries after an error. */
function useSourceTypes() {
  const [data, setData] = useState<SourceTypesResponse | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setError("");
    getJson<SourceTypesResponse>("/api/source-types").then(
      (r) => live && setData(r),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [attempt]);
  return { data, error, reload: () => setAttempt((a) => a + 1) };
}

function blank(): Source {
  return { id: "", name: "", enabled: true, parser: { type: "json" }, type: "http", config: {} };
}

function parseSseData(data: string): string {
  try {
    const v: unknown = JSON.parse(data);
    return typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return data;
  }
}

function useParsed(parser: ParserConfig, sample: string) {
  const [state, setState] = useState<{ parsed?: unknown; error?: string }>({});
  useEffect(() => {
    if (sample === "" || (parser.type === "regex" && !parser.pattern)) {
      setState({});
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      sendJson<{ parsed: unknown }>("POST", "/api/sources/test", { parser, sample }).then(
        (r) => live && setState({ parsed: r.parsed }),
        (e: Error) => live && setState({ error: e.message }),
      );
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [parser.type, parser.pattern, sample]);
  return state;
}

function ParsedView({ state }: { state: { parsed?: unknown; error?: string } }) {
  if (state.error) return <p className="form-error" role="alert">{state.error}</p>;
  if (state.parsed === undefined) return null;
  return <pre className="preview" aria-label="Parsed result">{JSON.stringify(state.parsed, null, 2)}</pre>;
}

interface StreamLine {
  uid: number;
  text: string;
}

function StreamMessage({ parser, line }: { parser: ParserConfig; line: string }) {
  const state = useParsed(parser, line);
  return (
    <li>
      <div className="mono muted">{line}</div>
      <ParsedView state={state} />
    </li>
  );
}

function MessageStream({ id, parser }: { id: string; parser: ParserConfig }) {
  const [lines, setLines] = useState<StreamLine[]>([]);
  useEffect(() => {
    setLines([]);
    let nextUid = 0;
    const es = new EventSource(`/api/sources/${encodeURIComponent(id)}/preview`);
    es.onmessage = (e: MessageEvent<string>) => {
      setLines((prev) => [{ uid: nextUid++, text: parseSseData(e.data) }, ...prev].slice(0, 20));
    };
    return () => es.close();
  }, [id]);
  return (
    <section className="cfg-panel" aria-label="Incoming messages">
      <h2>Incoming messages</h2>
      {lines.length === 0 ? (
        <p className="muted">Waiting for messages…</p>
      ) : (
        <ul className="stream">
          {lines.map((l) => (
            <StreamMessage key={l.uid} parser={parser} line={l.text} />
          ))}
        </ul>
      )}
    </section>
  );
}

export function SourceEditPage() {
  const { id } = useParams();
  return <SourceEditForm key={id} />;
}

function SourceEditForm() {
  const { id: routeId } = useParams();
  const isNew = routeId === "new";
  const navigate = useNavigate();
  const [src, setSrc] = useState<Source | null>(isNew ? blank() : null);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [idError, setIdError] = useState("");
  const [sample, setSample] = useState("");
  const [yaml, setYaml] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (isNew || !routeId) return;
    let live = true;
    getJson<Source>(`/api/sources/${encodeURIComponent(routeId)}`).then(
      (r) => live && setSrc(r),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [isNew, routeId]);

  const types = useSourceTypes();
  const firstType = types.data?.sourceTypes[0]?.type;
  useEffect(() => {
    // New source: default to the first type the server offers.
    if (!isNew || !types.data) return;
    setSrc((cur) =>
      cur && !types.data!.sourceTypes.some((t) => t.type === cur.type) && firstType
        ? { ...cur, type: firstType, config: {} }
        : cur,
    );
  }, [isNew, types.data, firstType]);

  const parsed = useParsed(src?.parser ?? { type: "json" }, sample);

  if (!src || !types.data) {
    const msg = error || types.error;
    return (
      <main className="page">
        <Link to="/config/sources">← Back to sources</Link>
        {msg ? (
          <>
            <p className="form-error" role="alert">{msg}</p>
            {types.error && !error && (
              <div className="actions">
                <button type="button" className="btn" onClick={types.reload}>
                  Retry
                </button>
              </div>
            )}
          </>
        ) : (
          <p className="muted">Loading…</p>
        )}
      </main>
    );
  }
  const sourceTypes = types.data.sourceTypes;
  const parserTypes = types.data.parserConfigSchema.properties.type?.enum?.map(String) ?? [];

  const patch = (p: Partial<Source>) => setSrc({ ...src, ...p } as Source);
  const emptySchema: JsonSchemaObject = { type: "object", properties: {} };
  const schema = sourceTypes.find((t) => t.type === src.type)?.configSchema ?? emptySchema;

  const save = async () => {
    setError("");
    const errs = validateConfig(schema, src.config);
    setFieldErrors(errs);
    let idErr = "";
    if (isNew) {
      if (!ID_RE.test(src.id)) idErr = "Use letters, digits, dash or underscore.";
      else if (RESERVED_IDS.includes(src.id)) idErr = `"${src.id}" is reserved. Choose another id.`;
    }
    setIdError(idErr);
    if (src.name.trim() === "") return setError("Name is required.");
    if (src.parser.type === "regex" && !src.parser.pattern) return setError("The regex parser needs a pattern.");
    if (idErr || Object.keys(errs).length > 0) return;
    setBusy(true);
    try {
      if (isNew) await sendJson<Source>("POST", "/api/sources", src);
      else await sendJson<Source>("PUT", `/api/sources/${encodeURIComponent(src.id)}`, src);
      navigate("/config/sources");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Delete source "${src.name}"?`)) return;
    try {
      await sendJson<unknown>("DELETE", `/api/sources/${encodeURIComponent(src.id)}`);
      navigate("/config/sources");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const exportYaml = async () => {
    try {
      const text = await getText(`/api/sources/${encodeURIComponent(src.id)}/export`);
      setYaml(text);
      const url = URL.createObjectURL(new Blob([text], { type: "application/yaml" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `${src.id}.yaml`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <main className="page">
      <Link to="/config/sources">← Back to sources</Link>
      <div className="src-head">
        <h1>{isNew ? "Add source" : "Edit source"}</h1>
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
      {error && <p className="form-error" role="alert">{error}</p>}
      {yaml && <pre className="preview" aria-label="Exported YAML">{yaml}</pre>}

      <section className="cfg-panel" aria-label="Source settings">
        <div className="field">
          <label htmlFor="src-id">Id</label>
          <input
            id="src-id"
            type="text"
            value={src.id}
            readOnly={!isNew}
            aria-invalid={idError ? true : undefined}
            onChange={(e) => patch({ id: e.target.value })}
          />
          {idError && <span className="field-error" role="alert">{idError}</span>}
        </div>
        <div className="field">
          <label htmlFor="src-name">Name</label>
          <input id="src-name" type="text" value={src.name} onChange={(e) => patch({ name: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="src-enabled">Enabled</label>
          <input id="src-enabled" type="checkbox" checked={src.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
        </div>
        <div className="field">
          <label htmlFor="src-type">Source type</label>
          <select
            id="src-type"
            value={src.type}
            onChange={(e) => {
              setFieldErrors({});
              patch({ type: e.target.value, config: {} });
            }}
          >
            {sourceTypes.map((t) => (
              <option key={t.type} value={t.type}>
                {sourceTypeLabel(t.type)}
              </option>
            ))}
            {!sourceTypes.some((t) => t.type === src.type) && (
              <option value={src.type}>{sourceTypeLabel(src.type)}</option>
            )}
          </select>
        </div>
        <SchemaForm
          schema={schema}
          value={src.config}
          errors={fieldErrors}
          idPrefix="cfg"
          onChange={(config) => patch({ config })}
        />
      </section>

      <section className="cfg-panel" aria-label="Parser">
        <div className="field">
          <label htmlFor="parser-type">Parser</label>
          <select
            id="parser-type"
            value={src.parser.type}
            onChange={(e) => {
              const type = e.target.value;
              patch({ parser: type === "regex" ? { type, pattern: src.parser.pattern ?? "" } : { type } });
            }}
          >
            {(parserTypes.includes(src.parser.type) ? parserTypes : [...parserTypes, src.parser.type]).map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
        {src.parser.type === "regex" && (
          <div className="field">
            <label htmlFor="parser-pattern">Regex pattern</label>
            <input
              id="parser-pattern"
              type="text"
              className="mono"
              spellCheck={false}
              value={src.parser.pattern ?? ""}
              onChange={(e) => patch({ parser: { type: "regex", pattern: e.target.value } })}
            />
            <span className="hint">Use named groups, for example (?&lt;level&gt;\w+) (?&lt;msg&gt;.*)</span>
          </div>
        )}
        <div className="field">
          <label htmlFor="parser-sample">Sample line</label>
          <textarea
            id="parser-sample"
            value={sample}
            spellCheck={false}
            placeholder="Paste a sample message to see how it parses"
            onChange={(e) => setSample(e.target.value)}
          />
        </div>
        <ParsedView state={parsed} />
      </section>

      {!isNew && <MessageStream id={src.id} parser={src.parser} />}

      <div className="actions">
        <button type="button" className="btn primary" disabled={busy} onClick={save}>
          Save
        </button>
        <Link to="/config/sources" className="btn" style={{ textDecoration: "none" }}>
          Cancel
        </Link>
      </div>
    </main>
  );
}
