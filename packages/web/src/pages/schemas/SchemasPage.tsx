import { FileCode2, FileUp, LayoutTemplate, ListChecks, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { parse as parseYaml } from "yaml";
import { ChooserTabs, CreateChooser, type CreateOption } from "../../components/CreateChooser";
import { Icon } from "../../components/Icon";
import { getJson, sendJson } from "../sources/api";
import { blankSchema, SCHEMA_EXAMPLES, SCHEMA_INTRO, yamlToSchema } from "./helpers";
import { SchemaEditor } from "./SchemaEditor";
import { COMMON_FIELDS, type Schema } from "./types";
import "./schemas.css";

const matchText = (s: Schema) => (typeof s.match === "string" ? s.match : "");

export function SchemasListPage() {
  const navigate = useNavigate();
  const [schemas, setSchemas] = useState<Schema[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    getJson<Schema[]>("/api/schemas").then(setSchemas, (e: Error) => setError(e.message));
  }, []);

  return (
    <main className="page sx-page">
      <header className="page-header">
        <div>
          <h1>Schemas</h1>
          <p className="page-intro">{SCHEMA_INTRO}</p>
        </div>
        <div className="page-actions">
          <Link className="btn" to="/config/schemas/new?mode=yaml">
            Import YAML
          </Link>
          <Link className="btn primary" to="/config/schemas/new">
            <Icon as={Plus} /> New schema
          </Link>
        </div>
      </header>
      {error && (
        <p role="alert" className="callout error">
          Couldn't load schemas: {error}
        </p>
      )}
      {schemas === null && !error && <p className="muted">Loading schemas…</p>}
      {schemas?.length === 0 && (
        <div className="empty-state">
          <p>No schemas yet. Without one, events keep their raw fields and alerts get no title or severity.</p>
          <Link className="btn primary" to="/config/schemas/new">
            Add the first schema
          </Link>
        </div>
      )}
      {schemas && schemas.length > 0 && (
        <table className="sx-table" aria-label="Schemas">
          <thead>
            <tr>
              <th>Name</th>
              <th>Applies to</th>
              <th>Alert fields</th>
            </tr>
          </thead>
          <tbody>
            {schemas.map((s) => {
              const href = `/config/schemas/${encodeURIComponent(s.id)}`;
              const n = Object.keys(s.mapping).length;
              return (
                <tr key={s.id} className="clickable" onClick={() => navigate(href)}>
                  <td>
                    <Link to={href} onClick={(e) => e.stopPropagation()}>
                      {s.name}
                    </Link>
                    <div className="muted mono sx-id">{s.id}</div>
                  </td>
                  <td>
                    <code className="sx-cond">{matchText(s) || "every event"}</code>
                  </td>
                  <td>
                    <span className="tag">
                      {n} of {COMMON_FIELDS.length} mapped
                    </span>
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
  { id: "editor", icon: ListChecks, title: "Build step by step", description: "Paste a sample event, then click its fields to map them." },
  { id: "example", icon: LayoutTemplate, title: "Start from an example", description: "Datadog, CloudWatch or Kubernetes, with a sample event." },
  { id: "yaml", icon: FileCode2, title: "Paste YAML", description: "Paste a schema exported from another environment or written by hand." },
  { id: "file", icon: FileUp, title: "Upload a YAML file", description: "Import a .yaml schema file from your computer." },
];

/** /config/schemas/new: the same flow as New rule and New source. */
export function NewSchemaPage() {
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
    const ex = SCHEMA_EXAMPLES.find((e) => e.id === exampleId);
    const imported = (location.state as { imported?: { schema: Schema; match: string } } | null)?.imported;
    const initial = imported?.schema ?? ex?.schema ?? blankSchema();
    const tab = imported && (from === "yaml" || from === "file") ? from : ex ? "example" : "editor";
    return (
      <SchemaEditor
        key={(exampleId ?? from ?? "blank") + (imported ? ":" + imported.schema.id : "")}
        isNew
        initial={initial}
        initialMatch={imported?.match ?? matchText(initial)}
        sample={ex?.sample}
        notice={imported ? "Imported. Paste a sample event to check the mapping, then save it." : undefined}
        tabs={<ChooserTabs options={OPTIONS} selected={tab} onSelect={choose} />}
      />
    );
  }

  function review(text: string, source: "yaml" | "file") {
    setError(null);
    try {
      setParams({ mode: "editor", from: source }, { replace: true, state: { imported: yamlToSchema(text, parseYaml) } });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <main className="page sx-page">
      <CreateChooser title="New schema" intro={SCHEMA_INTRO} options={OPTIONS} selected={mode} onSelect={choose}>
        {mode === "example" && (
          <ul className="example-list" aria-label="Examples">
            {SCHEMA_EXAMPLES.map((e) => (
              <li key={e.id}>
                <button type="button" className="example" onClick={() => setParams({ mode: "editor", example: e.id }, { replace: true })}>
                  <span className="example-name">{e.schema.name}</span>
                  <span className="example-what">{e.what}</span>
                  <code className="example-when">{matchText(e.schema)}</code>
                </button>
              </li>
            ))}
          </ul>
        )}
        {mode === "yaml" && (
          <div className="import-box">
            <label htmlFor="schema-yaml">Schema YAML</label>
            <textarea
              id="schema-yaml"
              className="code-input"
              spellCheck={false}
              placeholder={"id: datadog-monitor\nname: Datadog monitor\nmatch: aggregate matches *\nmapping:\n  title: { kind: path, path: title }\n  severity: { kind: path, path: alert_type }"}
              value={yaml}
              onChange={(e) => setYaml(e.target.value)}
            />
            <div className="import-actions">
              <button type="button" className="btn primary" disabled={yaml.trim() === ""} onClick={() => review(yaml, "yaml")}>
                Review schema
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
            Couldn't read the schema: {error}
          </p>
        )}
      </CreateChooser>
    </main>
  );
}

/** /config/schemas/:id: load the schema (formatting a tree match as text), then the editor. */
export function SchemaEditPage() {
  const { id } = useParams();
  const [loaded, setLoaded] = useState<{ schema: Schema; match: string } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!id) return;
    let live = true;
    setLoaded(null);
    getJson<Schema>(`/api/schemas/${encodeURIComponent(id)}`).then(
      async (s) => {
        let text = matchText(s);
        if (typeof s.match !== "string") {
          try {
            text = (await sendJson<{ text: string }>("POST", "/api/filters/format", { tree: s.match })).text;
          } catch {
            text = "";
          }
        }
        if (live) setLoaded({ schema: s, match: text });
      },
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [id]);
  if (error)
    return (
      <main className="page sx-page">
        <p role="alert" className="callout error">
          Couldn't load the schema: {error}
        </p>
        <Link to="/config/schemas">Back to schemas</Link>
      </main>
    );
  if (!loaded) return <main className="page sx-page muted">Loading schema…</main>;
  return <SchemaEditor key={loaded.schema.id} isNew={false} initial={loaded.schema} initialMatch={loaded.match} />;
}
