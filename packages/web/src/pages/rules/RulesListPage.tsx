import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { Rule } from "@alerting/shared";
import { importYaml, listRules } from "./api";
import { filterText, shortText } from "./helpers";
import "./rules.css";

export function RulesListPage() {
  const navigate = useNavigate();
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [yaml, setYaml] = useState("");
  const [importError, setImportError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    listRules().then(
      (r) => live && setRules(r),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, []);

  async function doImport() {
    setImportError(null);
    try {
      const rule = await importYaml(yaml);
      navigate("/rules/" + encodeURIComponent(rule.id));
    } catch (e) {
      setImportError((e as Error).message);
    }
  }

  return (
    <main className="rules-page">
      <div className="bar">
        <h1>Rules</h1>
        <div className="actions">
          <button type="button" onClick={() => setShowImport((v) => !v)}>
            Import YAML
          </button>
          <Link className="btn" to="/rules/new">
            New rule
          </Link>
        </div>
      </div>
      {showImport && (
        <section className="step">
          <label>
            YAML
            <textarea aria-label="YAML" value={yaml} onChange={(e) => setYaml(e.target.value)} />
          </label>
          <div className="actions">
            <button type="button" disabled={yaml.trim() === ""} onClick={doImport}>
              Import
            </button>
            {importError && (
              <span role="alert" className="error">
                {importError}
              </span>
            )}
          </div>
        </section>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {rules === null && !error && <p className="muted">Loading…</p>}
      {rules?.length === 0 && <p className="muted">No rules yet.</p>}
      <ul className="plain">
        {rules?.map((r) => (
          <li key={r.id} className="row">
            <span>
              <Link to={"/rules/" + encodeURIComponent(r.id)}>{r.name}</Link>{" "}
              <span className="muted">{r.enabled ? "enabled" : "disabled"}</span>
            </span>
            <code className="muted">{shortText(filterText(r.when)) || "(all events)"}</code>
          </li>
        ))}
      </ul>
    </main>
  );
}
