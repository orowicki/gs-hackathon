import { FileUp, FileCode2, LayoutTemplate, ListChecks } from "lucide-react";
import { useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import { parse as parseYaml } from "yaml";
import { ChooserTabs, CreateChooser, type CreateOption } from "../../components/CreateChooser";
import { emptyDraft, newWhoDraft, RULE_INTRO, yamlToDraft, type RuleDraft } from "./helpers";
import { RuleEditorPage } from "./RuleEditorPage";
import "./rules.css";

const OPTIONS: CreateOption[] = [
  {
    id: "editor",
    icon: ListChecks,
    title: "Build step by step",
    description: "Choose when it fires, who hears about it and how the alert reads.",
  },
  {
    id: "example",
    icon: LayoutTemplate,
    title: "Start from an example",
    description: "Pick a common rule, then adjust it in the editor.",
  },
  {
    id: "yaml",
    icon: FileCode2,
    title: "Paste YAML",
    description: "Paste a rule exported from another environment or written by hand.",
  },
  {
    id: "file",
    icon: FileUp,
    title: "Upload a YAML file",
    description: "Import a .yaml rule file from your computer.",
  },
];

interface Example {
  id: string;
  name: string;
  what: string;
  draft: Partial<RuleDraft>;
}

const EXAMPLES: Example[] = [
  {
    id: "critical-prod",
    name: "Critical alerts in production",
    what: "Any critical alert from a production service.",
    draft: { when: "alert.severity = critical AND alert.environment = prod", fields: "alert.source, alert.environment" },
  },
  {
    id: "settlement-failures",
    name: "Failed settlement workflows",
    what: "Order settlement workflows that fail in production.",
    draft: {
      when: "type = WORKFLOW_FAILED AND workflowName = order-settlement AND environment = prod",
      fields: "failedStep, errorMessage",
    },
  },
  {
    id: "pricing-warnings",
    name: "Pricing engine warnings",
    what: "Warnings and worse from any pricing engine region.",
    draft: { when: "alert.source matches pricing-engine-* AND alert.severity >= warning", fields: "alert.source" },
  },
  {
    id: "large-rejected-trades",
    name: "Large rejected trades",
    what: "Rejected trades with a notional above 1,000,000.",
    draft: { when: "alert.schema matches trade.rejected.* AND payload.notional > 1000000", fields: "payload.desk, payload.notional" },
  },
];

function exampleDraft(e: Example): RuleDraft {
  return { ...emptyDraft(), name: e.name, id: e.id, ...e.draft, who: [newWhoDraft()] };
}

/**
 * /rules/new: pick how to create the rule. Every way ends in the editor, so the rule is
 * reviewed (with its summary) before it is saved; YAML is parsed in the browser.
 * History: the 2x2 grid -> a way is one step; switching ways or opening the editor
 * replaces it, so Back always returns to the grid.
 */
export function NewRulePage() {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const mode = params.get("mode");
  const from = params.get("from");
  const exampleId = params.get("example");
  const [yaml, setYaml] = useState("");
  const [error, setError] = useState<string | null>(null);

  const choose = (id: string) => {
    setError(null);
    // From the grid (no mode yet) push, so Back returns to it; otherwise replace.
    setParams({ mode: id }, { replace: mode !== null });
  };

  if (mode === "editor") {
    const ex = EXAMPLES.find((e) => e.id === exampleId);
    const imported = (location.state as { draft?: RuleDraft } | null)?.draft;
    const initial = imported ?? (ex ? exampleDraft(ex) : undefined);
    const tab = imported && (from === "yaml" || from === "file") ? from : ex ? "example" : "editor";
    return (
      <RuleEditorPage
        key={(exampleId ?? from ?? "blank") + (imported ? ":" + imported.id : "")}
        initial={initial}
        notice={imported ? "Imported. Check the rule below, then save it." : undefined}
        tabs={<ChooserTabs options={OPTIONS} selected={tab} onSelect={choose} />}
      />
    );
  }

  /** Parse YAML here and open it in the editor for review. */
  function review(text: string, source: "yaml" | "file") {
    setError(null);
    try {
      const draft = yamlToDraft(text, parseYaml);
      setParams({ mode: "editor", from: source }, { replace: true, state: { draft } });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    review(await file.text(), "file");
  }

  return (
    <main className="page rules-page">
      <CreateChooser title="New rule" intro={RULE_INTRO} options={OPTIONS} selected={mode} onSelect={choose}>
        {mode === "example" && (
          <ul className="example-list" aria-label="Examples">
            {EXAMPLES.map((e) => (
              <li key={e.id}>
                <button
                  type="button"
                  className="example"
                  onClick={() => setParams({ mode: "editor", example: e.id }, { replace: true })}
                >
                  <span className="example-name">{e.name}</span>
                  <span className="example-what">{e.what}</span>
                  <code className="example-when">{e.draft.when}</code>
                </button>
              </li>
            ))}
          </ul>
        )}
        {mode === "yaml" && (
          <div className="import-box">
            <label htmlFor="rule-yaml">Rule YAML</label>
            <textarea
              id="rule-yaml"
              className="code-input"
              spellCheck={false}
              placeholder={"id: payments-critical\nname: Payments critical\nenabled: true\nwhen: alert.severity = critical\nwho:\n  - recipients: [{ type: group, id: payments-oncall }]\nlooks:\n  titleTemplate: \"{{alert.title}}\"\n  fields: [alert.source]"}
              value={yaml}
              onChange={(e) => setYaml(e.target.value)}
            />
            <div className="import-actions">
              <button type="button" className="btn primary" disabled={yaml.trim() === ""} onClick={() => review(yaml, "yaml")}>
                Review rule
              </button>
            </div>
          </div>
        )}
        {mode === "file" && (
          <label className="dropzone">
            <FileUp size={20} strokeWidth={1.5} aria-hidden="true" />
            <span>Choose a .yaml file</span>
            <span className="muted">It opens in the editor so you can check it before saving.</span>
            <input type="file" accept=".yaml,.yml,application/yaml,text/yaml" onChange={(e) => void onFile(e.target.files?.[0])} />
          </label>
        )}
        {error && (
          <p role="alert" className="callout error">
            Couldn't read the rule: {error}
          </p>
        )}
      </CreateChooser>
    </main>
  );
}
