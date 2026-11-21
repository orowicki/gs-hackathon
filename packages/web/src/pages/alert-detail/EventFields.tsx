import { Check, ChevronDown, ChevronRight, Copy } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Icon } from "../../components/Icon";
import { objectNodes, type Display, type TreeNode } from "./format";

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(() => {
      setDone(true);
      setTimeout(() => setDone(false), 1200);
    });
  };
  return (
    <button type="button" className="icon-btn small copy-btn" aria-label={label} title={label} onClick={copy}>
      <Icon as={done ? Check : Copy} />
    </button>
  );
}

export function ValueText({ display }: { display: Display }) {
  const cls = [display.muted ? "muted" : "", display.mono ? "mono" : ""].filter(Boolean).join(" ");
  return <span className={cls || undefined}>{display.text}</span>;
}

export function FieldRow({ label, path, children }: { label: string; path?: string; children: ReactNode }) {
  return (
    <div className="field-row">
      <dt title={path}>
        <span>{label}</span>
        {path ? <CopyButton text={path} label={`Copy path ${path}`} /> : null}
      </dt>
      <dd>{children}</dd>
    </div>
  );
}

function Section({ node }: { node: Extract<TreeNode, { kind: "section" }> }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="field-section">
      <div className="section-head" title={node.path}>
        <button type="button" className="section-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon as={open ? ChevronDown : ChevronRight} />
          <span>{node.label}</span>
        </button>
        <CopyButton text={node.path} label={`Copy path ${node.path}`} />
      </div>
      {open ? <Nodes nodes={node.children} nested /> : null}
    </div>
  );
}

function Nodes({ nodes, nested = false }: { nodes: TreeNode[]; nested?: boolean }) {
  return (
    <dl className={nested ? "fields nested" : "fields"}>
      {nodes.map((n) =>
        n.kind === "field" ? (
          <FieldRow key={n.path} label={n.label} path={n.path}>
            <ValueText display={n.display} />
          </FieldRow>
        ) : (
          <Section key={n.path} node={n} />
        ),
      )}
    </dl>
  );
}

/** The event rendered as "JSON without the brackets", plus a quiet raw JSON toggle. */
export function EventFields({ event, prefix = "payload" }: { event: Record<string, unknown>; prefix?: string }) {
  const [raw, setRaw] = useState(false);
  const json = JSON.stringify(event, null, 2);
  return (
    <section aria-label="Event data" className="event block">
      <h2>Event</h2>
      <Nodes nodes={objectNodes(event, prefix)} />
      <div className="raw">
        <button type="button" className="link-btn" aria-expanded={raw} onClick={() => setRaw(!raw)}>
          View raw JSON
        </button>
        {raw ? (
          <>
            <CopyButton text={json} label="Copy raw JSON" />
            <pre className="mono raw-json">{json}</pre>
          </>
        ) : null}
      </div>
    </section>
  );
}
