import { useState } from "react";
import { ChooserTabs, type CreateOption } from "../../components/CreateChooser";
import { CopyBox } from "../../components/CopyBox";
import { Bot, Braces, Monitor, Terminal } from "lucide-react";
import "./claude.css";

const CLIENTS: CreateOption[] = [
  { id: "code", icon: Terminal, title: "Claude Code", description: "Add the MCP server to Claude Code in your terminal." },
  { id: "desktop", icon: Monitor, title: "Claude Desktop", description: "Add the MCP server to the Claude Desktop app." },
  { id: "http", icon: Braces, title: "Any agent (HTTP API)", description: "Point any LLM agent that can make HTTP calls at the OpenAPI document." },
];

/** What the MCP server offers (packages/mcp/src/tools.ts). */
const TOOLS: { group: string; what: string; tools: string[] }[] = [
  {
    group: "Set up",
    what: "Create and change sources, schemas and rules. Changes apply at once, no restart.",
    tools: ["list_sources", "get_source", "create_source", "update_source", "delete_source", "list_schemas", "create_schema", "update_schema", "list_rules", "create_rule", "update_rule"],
  },
  { group: "Check", what: "Validate a filter before saving it, and look at what is arriving.", tools: ["validate_filter", "list_recent_events"] },
  { group: "Operate", what: "Read alerts and act on them; the actor is recorded in the audit log.", tools: ["list_alerts", "acknowledge_alert", "resolve_alert"] },
];

const EXAMPLE_PROMPT =
  'Add an HTTP source "billing", a schema for events shaped like {"invoice": {"id": "INV-1", "status": "failed", "amount": 120}} ' +
  "that maps the title and sets severity to error, and a rule that notifies the Pricing team on severity >= error. " +
  "Then send one sample event to the billing source and check that an alert appears.";

export function ConnectClaudePage() {
  const [client, setClient] = useState("code");
  const origin = window.location.origin;
  // The Vite dev/preview servers (5173/4173) proxy the API, but Claude talks to the app directly.
  const api = /:(5173|4173)$/.test(origin) ? origin.replace(/:\d+$/, ":3000") : origin;
  const repo = "/path/to/gs-hackathon";

  return (
    <main className="page cc-page">
      <header className="page-header">
        <div>
          <h1>Connect Claude</h1>
          <p className="page-intro">
            Claude can set this service up for you: add sources, write schemas from a sample, create rules, and handle alerts. Connect it once, then
            ask in plain words.
          </p>
        </div>
      </header>

      <ChooserTabs options={CLIENTS} selected={client} onSelect={setClient} />

      <div className="cc-layout">
        <section className="cc-panel" aria-label="Setup">
          {client === "code" && (
            <ol className="cc-steps">
              <li>
                <h2>Build the MCP server</h2>
                <p>Once per clone, from the repository root.</p>
                <CopyBox label="Command" text="npm run build --workspace @alerting/mcp" />
              </li>
              <li>
                <h2>Add it to Claude Code</h2>
                <p>Replace the path with where you cloned the repository.</p>
                <CopyBox label="Command" text={`claude mcp add alerting -e ALERTING_API_URL=${api} -- node ${repo}/packages/mcp/dist/main.js`} />
              </li>
              <li>
                <h2>Ask Claude</h2>
                <p>Start Claude Code and describe what you want. It uses the alerting tools on its own.</p>
                <CopyBox label="Example prompt" text={EXAMPLE_PROMPT} multiline />
              </li>
            </ol>
          )}
          {client === "desktop" && (
            <ol className="cc-steps">
              <li>
                <h2>Build the MCP server</h2>
                <p>Once per clone, from the repository root.</p>
                <CopyBox label="Command" text="npm run build --workspace @alerting/mcp" />
              </li>
              <li>
                <h2>Add it to claude_desktop_config.json</h2>
                <p>Settings, Developer, Edit config. Replace the path with where you cloned the repository, then restart Claude Desktop.</p>
                <CopyBox
                  label="Config"
                  multiline
                  text={JSON.stringify(
                    { mcpServers: { alerting: { command: "node", args: [`${repo}/packages/mcp/dist/main.js`], env: { ALERTING_API_URL: api } } } },
                    null,
                    2,
                  )}
                />
              </li>
              <li>
                <h2>Ask Claude</h2>
                <p>The alerting tools appear in the tools menu.</p>
                <CopyBox label="Example prompt" text={EXAMPLE_PROMPT} multiline />
              </li>
            </ol>
          )}
          {client === "http" && (
            <ol className="cc-steps">
              <li>
                <h2>Give the agent the API description</h2>
                <p>Every endpoint is documented with request and response schemas and examples.</p>
                <CopyBox label="OpenAPI document" text={`${api}/api/openapi.json`} />
                <a className="cc-link" href={`${api}/api/openapi.json`} target="_blank" rel="noreferrer">
                  Open the OpenAPI document
                </a>
              </li>
              <li>
                <h2>Ask it to configure the service</h2>
                <CopyBox label="Example prompt" text={`Using the API described at ${api}/api/openapi.json: ${EXAMPLE_PROMPT}`} multiline />
              </li>
            </ol>
          )}
        </section>

        <aside className="cc-panel cc-tools" aria-label="What Claude can do">
          <h2>
            <Bot size={16} aria-hidden="true" /> What Claude can do
          </h2>
          {TOOLS.map((g) => (
            <div key={g.group} className="cc-group">
              <h3>{g.group}</h3>
              <p>{g.what}</p>
              <ul>
                {g.tools.map((t) => (
                  <li key={t} className="mono">
                    {t}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </aside>
      </div>
    </main>
  );
}
