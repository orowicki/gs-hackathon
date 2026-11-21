import { Check, Database, Download, FileText, Globe, Plug, Trash2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Step } from "../../components/EditorStep";
import { CopyBox } from "../../components/CopyBox";
import { Icon } from "../../components/Icon";
import { getJson, getText, sendJson } from "./api";
import { ID_RE, ingestUrl, localParse, parserLabel, slugify, SOURCE_INTRO, sourceSentence } from "./helpers";
import { SchemaForm, validateConfig } from "./SchemaForm";
import { RESERVED_IDS, sourceTypeLabel, type JsonSchemaObject, type ParserConfig, type Source, type SourceTypesResponse } from "./sourceTypes";
import "./sources.css";

const TYPE_INFO: Record<string, { icon: LucideIcon; text: string }> = {
  http: { icon: Globe, text: "Services send events to a URL on this app." },
  file_tail: { icon: FileText, text: "Follow log files on disk as they grow." },
  redis_stream: { icon: Database, text: "Read messages from a Redis stream." },
};
const PARSER_HELP: Record<string, string> = {
  json: "One JSON object per message.",
  logfmt: "key=value pairs, quotes allowed.",
  regex: "Plain text split by a pattern with named groups.",
  raw: "Keep the whole line as the message.",
};

/** Source types rarely change: fetched once per page load and shared, so opening the
 *  editor again (tabs, examples) renders immediately instead of flashing a loading state. */
let typesCache: SourceTypesResponse | null = null;

/** GET /api/source-types (cached); `reload` retries after an error. */
export function useSourceTypes() {
  const [data, setData] = useState<SourceTypesResponse | null>(typesCache);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (typesCache && attempt === 0) return;
    let live = true;
    setError("");
    getJson<SourceTypesResponse>("/api/source-types").then(
      (r) => {
        typesCache = r;
        if (live) setData(r);
      },
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [attempt]);
  return { data, error, reload: () => setAttempt((a) => a + 1) };
}

type ParseState = { parsed?: Record<string, unknown>; error?: string; local?: boolean };

/** Parses the sample with the server (POST /api/sources/test); falls back to the browser while that route is missing (#133). */
function useParsed(parser: ParserConfig, sample: string): ParseState {
  const [state, setState] = useState<ParseState>({});
  useEffect(() => {
    if (sample.trim() === "") return setState({});
    let live = true;
    const t = setTimeout(() => {
      sendJson<{ parsed: Record<string, unknown> }>("POST", "/api/sources/test", { parser, sample }).then(
        (r) => live && setState({ parsed: r.parsed }),
        (e: Error) => {
          if (!live) return;
          if (!/not found|404/i.test(e.message)) return setState({ error: e.message });
          try {
            setState({ parsed: localParse(parser, sample), local: true });
          } catch (err) {
            setState({ error: (err as Error).message, local: true });
          }
        },
      );
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [parser.type, parser.pattern, sample]);
  return state;
}

function ParsedFields({ state }: { state: ParseState }) {
  if (state.error)
    return (
      <p className="src-parse-error" role="alert">
        {state.error}
      </p>
    );
  if (!state.parsed) return null;
  const entries = Object.entries(state.parsed);
  return (
    <div className="src-parsed" aria-label="Parsed result">
      <div className="src-parsed-head">
        <Icon as={Check} /> Parsed into {entries.length} field{entries.length === 1 ? "" : "s"}
        {state.local && <span className="re-hint"> · preview computed in the browser</span>}
      </div>
      <dl>
        {entries.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{typeof v === "string" ? v : JSON.stringify(v)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** Live messages for a saved source (GET /api/sources/:id/preview, SSE). */
function IncomingMessages({ id }: { id: string }) {
  const [lines, setLines] = useState<{ uid: number; text: string }[]>([]);
  const [down, setDown] = useState(false);
  useEffect(() => {
    let uid = 0;
    let got = false;
    const es = new EventSource(`/api/sources/${encodeURIComponent(id)}/preview`);
    es.onmessage = (e: MessageEvent<string>) => {
      got = true;
      let text = e.data;
      try {
        const v: unknown = JSON.parse(e.data);
        text = typeof v === "string" ? v : JSON.stringify((v as { raw?: unknown })?.raw ?? v);
      } catch {
        /* plain text */
      }
      setLines((prev) => [{ uid: uid++, text }, ...prev].slice(0, 20));
    };
    es.onerror = () => {
      if (!got) {
        setDown(true);
        es.close();
      }
    };
    return () => es.close();
  }, [id]);
  return (
    <section className="re-suggestions" aria-label="Incoming messages">
      <h2>Incoming messages</h2>
      {down ? (
        <p className="muted">Live preview isn't available on this server yet.</p>
      ) : lines.length === 0 ? (
        <p className="muted">Waiting for messages…</p>
      ) : (
        <ul className="src-stream">
          {lines.map((l) => (
            <li key={l.uid} className="mono">
              {l.text}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function SourceEditor({
  initial,
  isNew,
  tabs,
  notice,
  sample: initialSample = "",
}: {
  initial: Source;
  isNew: boolean;
  tabs?: ReactNode;
  notice?: string;
  sample?: string;
}) {
  const navigate = useNavigate();
  const types = useSourceTypes();
  const [src, setSrc] = useState<Source>(initial);
  const [idTouched, setIdTouched] = useState(!isNew || initial.id !== "");
  const [errors, setErrors] = useState<string[]>([]);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [idError, setIdError] = useState("");
  const [sample, setSample] = useState(initialSample);
  const [yaml, setYaml] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const parsed = useParsed(src.parser, sample);

  const patch = (p: Partial<Source>) => setSrc((s) => ({ ...s, ...p }));

  const header = (
    <>
      <header className="page-header">
        <div>
          <h1>{isNew ? "New source" : src.name || "Edit source"}</h1>
          <p className="page-intro">{isNew ? SOURCE_INTRO : `Source id ${src.id}`}</p>
        </div>
      </header>
      {tabs}
      {notice && <p className="callout info">{notice}</p>}
    </>
  );

  if (!types.data) {
    // Same header and tabs as the loaded page, so nothing jumps when the types arrive.
    return (
      <main className="page src-page re-page">
        {header}
        {types.error ? (
          <p className="callout error" role="alert">
            Couldn't load source types: {types.error}{" "}
            <button type="button" className="link-btn" onClick={types.reload}>
              Retry
            </button>
          </p>
        ) : (
          <p className="muted">Loading source types…</p>
        )}
      </main>
    );
  }

  const sourceTypes = types.data.sourceTypes;
  const parserTypes = types.data.parserConfigSchema.properties.type?.enum?.map(String) ?? ["json", "logfmt", "regex", "raw"];
  const empty: JsonSchemaObject = { type: "object", properties: {} };
  const schema = sourceTypes.find((t) => t.type === src.type)?.configSchema ?? empty;

  async function save() {
    const errs = validateConfig(schema, src.config);
    setFieldErrors(errs);
    let idErr = "";
    if (isNew) {
      if (!ID_RE.test(src.id)) idErr = "Use letters, digits, dash or underscore.";
      else if (RESERVED_IDS.includes(src.id)) idErr = `"${src.id}" is reserved. Choose another id.`;
    }
    setIdError(idErr);
    const problems: string[] = [];
    if (src.name.trim() === "") problems.push("Name is required.");
    if (src.parser.type === "regex" && !src.parser.pattern) problems.push("The regex parser needs a pattern.");
    if (idErr) problems.push(idErr);
    if (Object.keys(errs).length > 0) problems.push("Fill in the required connection settings.");
    setErrors(problems);
    if (problems.length > 0) return;
    setBusy(true);
    try {
      if (isNew) await sendJson<Source>("POST", "/api/sources", src);
      else await sendJson<Source>("PUT", `/api/sources/${encodeURIComponent(src.id)}`, src);
      navigate("/config/sources");
    } catch (e) {
      setErrors([(e as Error).message]);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Delete source "${src.name}"? Events from it will stop arriving.`)) return;
    try {
      await sendJson<unknown>("DELETE", `/api/sources/${encodeURIComponent(src.id)}`);
      navigate("/config/sources");
    } catch (e) {
      setErrors([(e as Error).message]);
    }
  }

  async function exportYaml() {
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
      setErrors([(e as Error).message]);
    }
  }

  const curl = `curl -X POST ${ingestUrl(src.id)} -H 'content-type: application/json' -d '{"type":"TEST","message":"hello"}'`;

  return (
    <main className="page src-page re-page">
      {header}

      <div className="re-layout">
        <div className="re-steps">
          <Step n={1} title="Type" help="Where the events come from.">
            <div className="src-types" role="radiogroup" aria-label="Source type">
              {[...sourceTypes.map((t) => t.type), ...(sourceTypes.some((t) => t.type === src.type) ? [] : [src.type])].map((t) => {
                const info = TYPE_INFO[t] ?? { icon: Plug, text: "A source type provided by a plugin." };
                const on = src.type === t;
                return (
                  <button
                    key={t}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    className={on ? "src-type on" : "src-type"}
                    onClick={() => {
                      if (on) return;
                      setFieldErrors({});
                      patch({ type: t, config: {} });
                    }}
                  >
                    <span className="choice-icon">
                      <Icon as={info.icon} />
                    </span>
                    <span className="choice-title">{sourceTypeLabel(t)}</span>
                    <span className="choice-text">{info.text}</span>
                  </button>
                );
              })}
            </div>
          </Step>

          <Step n={2} title="Name and status" help="A name people will recognise on alerts.">
            <div className="re-grid-2">
              <label className="field">
                Name
                <input
                  type="text"
                  value={src.name}
                  placeholder="Payments API logs"
                  onChange={(e) => patch(idTouched ? { name: e.target.value } : { name: e.target.value, id: slugify(e.target.value) })}
                />
              </label>
              <div className="field">
                <label htmlFor="src-id">Id</label>
                <input
                  id="src-id"
                  type="text"
                  className="mono"
                  value={src.id}
                  readOnly={!isNew}
                  aria-invalid={idError ? true : undefined}
                  aria-describedby={idError ? "src-id-error" : undefined}
                  onChange={(e) => {
                    setIdTouched(true);
                    patch({ id: e.target.value });
                  }}
                />
                {idError && (
                  <span id="src-id-error" className="src-parse-error">
                    {idError}
                  </span>
                )}
              </div>
            </div>
            <label className="switch">
              <input type="checkbox" checked={src.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
              <span className="switch-track" aria-hidden="true" />
              Enabled
            </label>
          </Step>

          <Step
            n={3}
            title="Connection"
            help={src.type === "http" ? "Nothing to set up: services send events to this source's URL." : "Where to read from."}
          >
            {src.type === "http" ? (
              <>
                <CopyBox label="Ingest URL" text={ingestUrl(src.id)} />
                <CopyBox label="Send a test event" text={curl} />
              </>
            ) : (
              <div className="src-schema-form">
                <SchemaForm schema={schema} value={src.config} errors={fieldErrors} idPrefix="cfg" onChange={(config) => patch({ config })} />
              </div>
            )}
          </Step>

          <Step n={4} title="Parsing" help="How each message is split into fields that schemas and rules can use.">
            <div className="segmented-sm" role="radiogroup" aria-label="Parser">
              {(parserTypes.includes(src.parser.type) ? parserTypes : [...parserTypes, src.parser.type]).map((p) => (
                <button
                  key={p}
                  type="button"
                  role="radio"
                  aria-checked={src.parser.type === p}
                  className={src.parser.type === p ? "seg on" : "seg"}
                  onClick={() => patch({ parser: p === "regex" ? { type: p, pattern: src.parser.pattern ?? "" } : { type: p } })}
                >
                  {p === "json" ? "JSON" : p === "logfmt" ? "logfmt" : p === "regex" ? "Regex" : "Raw"}
                </button>
              ))}
            </div>
            <span className="re-hint">{PARSER_HELP[src.parser.type] ?? ""}</span>
            {src.parser.type === "regex" && (
              <label className="field">
                Regex pattern
                <input
                  type="text"
                  className="mono"
                  spellCheck={false}
                  value={src.parser.pattern ?? ""}
                  placeholder="^(?<level>\w+) (?<message>.*)$"
                  onChange={(e) => patch({ parser: { type: "regex", pattern: e.target.value } })}
                />
              </label>
            )}
            <label className="field">
              Sample line
              <textarea
                className="mono"
                rows={2}
                spellCheck={false}
                value={sample}
                placeholder="Paste one message to see how it is parsed"
                onChange={(e) => setSample(e.target.value)}
              />
            </label>
            <ParsedFields state={parsed} />
          </Step>

          {!isNew && <IncomingMessages id={src.id} />}
          {yaml !== null && (
            <pre className="code-block" aria-label="Exported YAML">
              {yaml}
            </pre>
          )}
        </div>

        <aside className="re-summary" aria-label="Source summary">
          <h2>Summary</h2>
          <p className="re-sentence">{sourceSentence(src)}</p>
          <dl className="re-facts">
            <div>
              <dt>Status</dt>
              <dd>
                <span className={src.enabled ? "tag ok" : "tag"}>{src.enabled ? "Enabled" : "Disabled"}</span>
              </dd>
            </div>
            <div>
              <dt>Type</dt>
              <dd>{sourceTypeLabel(src.type)}</dd>
            </div>
            <div>
              <dt>Parser</dt>
              <dd>{parserLabel(src.parser.type)}</dd>
            </div>
            <div>
              <dt>Sample</dt>
              <dd>{parsed.parsed ? `${Object.keys(parsed.parsed).length} fields` : parsed.error ? "doesn't parse" : "—"}</dd>
            </div>
          </dl>
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
        <Link className="btn" to="/config/sources">
          {isNew ? "Cancel" : "Back to sources"}
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
          Save source
        </button>
      </footer>
    </main>
  );
}
