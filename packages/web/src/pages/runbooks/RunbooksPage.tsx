import type { Runbook } from "@alerting/shared";
import { FileCode2, FileUp, LayoutTemplate, ListChecks, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { parse as parseYaml } from "yaml";
import { ChooserTabs, CreateChooser, type CreateOption } from "../../components/CreateChooser";
import { Icon } from "../../components/Icon";
import { blankRunbook, RUNBOOK_EXAMPLES, RUNBOOK_INTRO, yamlToRunbook } from "./helpers";
import { RunbookEditor } from "./RunbookEditor";
import "./runbooks.css";

const matchText = (r: Runbook) => (typeof r.matches === "string" ? r.matches : "");
/** Runbooks attached to one rule are written `alert.ruleId = "<id>"`. */
const ruleOf = (r: Runbook) => /^alert\.ruleId = "?([\w-]+)"?$/.exec(matchText(r).trim())?.[1];

export function RunbooksListPage() {
  const navigate = useNavigate();
  const [list, setList] = useState<Runbook[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/runbooks")
      .then(async (r) => (r.ok ? setList((await r.json()) as Runbook[]) : setError(`HTTP ${r.status}`)))
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <main className="page rb-page">
      <header className="page-header">
        <div>
          <h1>Runbooks</h1>
          <p className="page-intro">{RUNBOOK_INTRO}</p>
        </div>
        <div className="page-actions">
          <Link className="btn" to="/config/runbooks/new?mode=yaml">
            Import YAML
          </Link>
          <Link className="btn primary" to="/config/runbooks/new">
            <Icon as={Plus} /> New runbook
          </Link>
        </div>
      </header>
      {error && (
        <p role="alert" className="callout error">
          Couldn't load runbooks: {error}
        </p>
      )}
      {list === null && !error && <p className="muted">Loading runbooks…</p>}
      {list?.length === 0 && (
        <div className="empty-state">
          <p>No runbooks yet. Alerts will only say what went wrong, not what to do.</p>
          <Link className="btn primary" to="/config/runbooks/new">
            Add the first runbook
          </Link>
        </div>
      )}
      {list && list.length > 0 && (
        <table className="rb-table" aria-label="Runbooks">
          <thead>
            <tr>
              <th>Name</th>
              <th>Shown on</th>
              <th>What it does</th>
            </tr>
          </thead>
          <tbody>
            {list.map((r) => {
              const href = `/config/runbooks/${encodeURIComponent(r.id)}`;
              const rule = ruleOf(r);
              const approvals = r.type === "automation" ? r.steps.filter((s) => s.approval === "required").length : 0;
              return (
                <tr key={r.id} className="clickable" onClick={() => navigate(href)}>
                  <td>
                    <Link to={href} onClick={(e) => e.stopPropagation()}>
                      {r.name}
                    </Link>
                    <div className="muted mono rb-id">{r.id}</div>
                  </td>
                  <td>
                    {rule ? (
                      <span className="muted">
                        Alerts of rule <span className="mono">{rule}</span>
                      </span>
                    ) : (
                      <code className="rb-cond">{matchText(r) || "every alert"}</code>
                    )}
                  </td>
                  <td>
                    {r.type === "text" ? (
                      <span className="tag">Instructions</span>
                    ) : (
                      <>
                        <span className="tag">
                          {r.steps.length} step{r.steps.length === 1 ? "" : "s"}
                        </span>{" "}
                        {approvals > 0 && <span className="tag sev-warning">{approvals} need approval</span>}
                      </>
                    )}
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
  { id: "editor", icon: ListChecks, title: "Build step by step", description: "Write instructions, or chain HTTP calls, escalations and waits." },
  { id: "example", icon: LayoutTemplate, title: "Start from an example", description: "Restart with approval, escalate after a wait, or a checklist." },
  { id: "yaml", icon: FileCode2, title: "Paste YAML", description: "Paste a runbook exported from another environment or written by hand." },
  { id: "file", icon: FileUp, title: "Upload a YAML file", description: "Import a .yaml runbook file from your computer." },
];

/** /config/runbooks/new: the same flow as rules, sources and schemas. */
export function NewRunbookPage() {
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
    const ex = RUNBOOK_EXAMPLES.find((e) => e.id === exampleId);
    const imported = (location.state as { imported?: Runbook } | null)?.imported;
    const tab = imported && (from === "yaml" || from === "file") ? from : ex ? "example" : "editor";
    return (
      <RunbookEditor
        key={(exampleId ?? from ?? "blank") + (imported ? ":" + imported.id : "")}
        isNew
        initial={imported ?? ex?.runbook ?? blankRunbook()}
        notice={imported ? "Imported. Check the runbook below, then save it." : undefined}
        tabs={<ChooserTabs options={OPTIONS} selected={tab} onSelect={choose} />}
      />
    );
  }

  function review(text: string, source: "yaml" | "file") {
    setError(null);
    try {
      setParams({ mode: "editor", from: source }, { replace: true, state: { imported: yamlToRunbook(text, parseYaml) } });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <main className="page rb-page">
      <CreateChooser title="New runbook" intro={RUNBOOK_INTRO} options={OPTIONS} selected={mode} onSelect={choose}>
        {mode === "example" && (
          <ul className="example-list" aria-label="Examples">
            {RUNBOOK_EXAMPLES.map((e) => (
              <li key={e.id}>
                <button type="button" className="example" onClick={() => setParams({ mode: "editor", example: e.id }, { replace: true })}>
                  <span className="example-name">{e.runbook.name}</span>
                  <span className="example-what">{e.what}</span>
                  <code className="example-when">{matchText(e.runbook)}</code>
                </button>
              </li>
            ))}
          </ul>
        )}
        {mode === "yaml" && (
          <div className="import-box">
            <label htmlFor="runbook-yaml">Runbook YAML</label>
            <textarea
              id="runbook-yaml"
              className="code-input"
              spellCheck={false}
              placeholder={"id: escalate-critical\nname: Escalate unhandled critical alerts\ntype: automation\nmatches: alert.severity = critical\nsteps:\n  - action: wait\n    duration: 5m\n  - action: escalate\n    group: settlements-oncall"}
              value={yaml}
              onChange={(e) => setYaml(e.target.value)}
            />
            <div className="import-actions">
              <button type="button" className="btn primary" disabled={yaml.trim() === ""} onClick={() => review(yaml, "yaml")}>
                Review runbook
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
            Couldn't read the runbook: {error}
          </p>
        )}
      </CreateChooser>
    </main>
  );
}

export function RunbookEditPage() {
  const { id } = useParams();
  const [rb, setRb] = useState<Runbook | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!id) return;
    let live = true;
    setRb(null);
    fetch(`/api/runbooks/${encodeURIComponent(id)}`)
      .then(async (r) => {
        if (!live) return;
        if (r.ok) setRb((await r.json()) as Runbook);
        else setError(r.status === 404 ? "No runbook with this id." : `HTTP ${r.status}`);
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [id]);
  if (error)
    return (
      <main className="page rb-page">
        <p role="alert" className="callout error">
          Couldn't load the runbook: {error}
        </p>
        <Link to="/config/runbooks">Back to runbooks</Link>
      </main>
    );
  if (!rb) return <main className="page rb-page muted">Loading runbook…</main>;
  return <RunbookEditor key={rb.id} isNew={false} initial={rb} />;
}
