import { FileCode2, FileUp, LayoutTemplate, ListChecks, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { parse as parseYaml } from "yaml";
import { ChooserTabs, CreateChooser, type CreateOption } from "../../components/CreateChooser";
import { Icon } from "../../components/Icon";
import { getJson } from "./api";
import { blankSource, ingestUrl, parserLabel, SOURCE_EXAMPLES, SOURCE_INTRO, yamlToSource } from "./helpers";
import { SourceEditor } from "./SourceEditor";
import { sourceTypeLabel, type Source } from "./sourceTypes";
import "./sources.css";

function where(s: Source): string {
  if (s.type === "http") return new URL(ingestUrl(s.id)).pathname;
  if (s.type === "file_tail" && typeof s.config.path === "string") return s.config.path;
  if (s.type === "redis_stream" && typeof s.config.stream === "string") return s.config.stream;
  if (s.type === "kafka" && typeof s.config.topic === "string") return s.config.topic;
  return "";
}

export function SourcesListPage() {
  const navigate = useNavigate();
  const [sources, setSources] = useState<Source[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    getJson<Source[]>("/api/sources").then(setSources, (e: Error) => setError(e.message));
  }, []);

  return (
    <main className="page src-page">
      <header className="page-header">
        <div>
          <h1>Sources</h1>
          <p className="page-intro">{SOURCE_INTRO}</p>
        </div>
        <div className="page-actions">
          <Link className="btn" to="/config/sources/new?mode=yaml">
            Import YAML
          </Link>
          <Link className="btn primary" to="/config/sources/new">
            <Icon as={Plus} /> New source
          </Link>
        </div>
      </header>
      {error && (
        <p role="alert" className="callout error">
          Couldn't load sources: {error}
        </p>
      )}
      {sources === null && !error && <p className="muted">Loading sources…</p>}
      {sources?.length === 0 && (
        <div className="empty-state">
          <p>No sources yet. Add one so events can start arriving.</p>
          <Link className="btn primary" to="/config/sources/new">
            Add the first source
          </Link>
        </div>
      )}
      {sources && sources.length > 0 && (
        <table className="src-table" aria-label="Sources">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Reads from</th>
              <th>Parser</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {sources.map((s) => {
              const href = `/config/sources/${encodeURIComponent(s.id)}`;
              return (
                <tr key={s.id} className="clickable" onClick={() => navigate(href)}>
                  <td>
                    <Link to={href} onClick={(e) => e.stopPropagation()}>
                      {s.name}
                    </Link>
                    <div className="muted mono src-id">{s.id}</div>
                  </td>
                  <td>{sourceTypeLabel(s.type)}</td>
                  <td className="mono src-where">{where(s)}</td>
                  <td>{parserLabel(s.parser.type)}</td>
                  <td>
                    <span className={s.enabled ? "tag ok" : "tag"}>{s.enabled ? "Enabled" : "Disabled"}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </main>
  );
}

const OPTIONS: CreateOption[] = [
  { id: "editor", icon: ListChecks, title: "Build step by step", description: "Pick the type, connection and parser, and test it on a sample message." },
  { id: "example", icon: LayoutTemplate, title: "Start from an example", description: "A webhook, log files or a Redis stream, ready to adjust." },
  { id: "yaml", icon: FileCode2, title: "Paste YAML", description: "Paste a source exported from another environment or written by hand." },
  { id: "file", icon: FileUp, title: "Upload a YAML file", description: "Import a .yaml source file from your computer." },
];

/**
 * /config/sources/new, the same flow as New rule: choose a way, every way ends in the
 * editor (imports are reviewed before saving), Back returns to the grid.
 */
export function NewSourcePage() {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const mode = params.get("mode");
  const from = params.get("from");
  const exampleId = params.get("example");
  const [yaml, setYaml] = useState("");
  const [error, setError] = useState<string | null>(null);

  const choose = (id: string) => {
    setError(null);
    setParams({ mode: id }, { replace: mode !== null });
  };

  if (mode === "editor") {
    const ex = SOURCE_EXAMPLES.find((e) => e.id === exampleId);
    const imported = (location.state as { source?: Source } | null)?.source;
    const initial = imported ?? ex?.source ?? blankSource();
    const tab = imported && (from === "yaml" || from === "file") ? from : ex ? "example" : "editor";
    return (
      <SourceEditor
        key={(exampleId ?? from ?? "blank") + (imported ? ":" + imported.id : "")}
        isNew
        initial={initial}
        sample={ex?.sample}
        notice={imported ? "Imported. Check the source below, then save it." : undefined}
        tabs={<ChooserTabs options={OPTIONS} selected={tab} onSelect={choose} />}
      />
    );
  }

  function review(text: string, source: "yaml" | "file") {
    setError(null);
    try {
      setParams({ mode: "editor", from: source }, { replace: true, state: { source: yamlToSource(text, parseYaml) } });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <main className="page src-page">
      <CreateChooser title="New source" intro={SOURCE_INTRO} options={OPTIONS} selected={mode} onSelect={choose}>
        {mode === "example" && (
          <ul className="example-list" aria-label="Examples">
            {SOURCE_EXAMPLES.map((e) => (
              <li key={e.id}>
                <button type="button" className="example" onClick={() => setParams({ mode: "editor", example: e.id }, { replace: true })}>
                  <span className="example-name">{e.source.name}</span>
                  <span className="example-what">{e.what}</span>
                  <code className="example-when">
                    {sourceTypeLabel(e.source.type)} · {parserLabel(e.source.parser.type)}
                  </code>
                </button>
              </li>
            ))}
          </ul>
        )}
        {mode === "yaml" && (
          <div className="import-box">
            <label htmlFor="source-yaml">Source YAML</label>
            <textarea
              id="source-yaml"
              className="code-input"
              spellCheck={false}
              placeholder={"id: payments-logs\nname: Payments API logs\nenabled: true\ntype: file_tail\nconfig:\n  path: /var/log/payments/*.log\nparser:\n  type: logfmt"}
              value={yaml}
              onChange={(e) => setYaml(e.target.value)}
            />
            <div className="import-actions">
              <button type="button" className="btn primary" disabled={yaml.trim() === ""} onClick={() => review(yaml, "yaml")}>
                Review source
              </button>
            </div>
          </div>
        )}
        {mode === "file" && (
          <label className="dropzone">
            <FileUp size={20} strokeWidth={1.5} aria-hidden="true" />
            <span>Choose a .yaml file</span>
            <span className="muted">It opens in the editor so you can check it before saving.</span>
            <input
              type="file"
              aria-label="YAML file"
              accept=".yaml,.yml,application/yaml,text/yaml"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) review(await f.text(), "file");
              }}
            />
          </label>
        )}
        {error && (
          <p role="alert" className="callout error">
            Couldn't read the source: {error}
          </p>
        )}
      </CreateChooser>
    </main>
  );
}

/** /config/sources/:id: load the source, then the same editor. */
export function SourceEditPage() {
  const { id } = useParams();
  const [src, setSrc] = useState<Source | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!id) return;
    let live = true;
    setSrc(null);
    getJson<Source>(`/api/sources/${encodeURIComponent(id)}`).then(
      (r) => live && setSrc(r),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [id]);
  if (error)
    return (
      <main className="page src-page">
        <p role="alert" className="callout error">
          Couldn't load the source: {error}
        </p>
        <Link to="/config/sources">Back to sources</Link>
      </main>
    );
  if (!src) return <main className="page src-page muted">Loading source…</main>;
  return <SourceEditor key={src.id} isNew={false} initial={src} />;
}
