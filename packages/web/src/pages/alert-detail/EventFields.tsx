import { Check, Copy } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Icon } from "../../components/Icon";
import { eventGroups, type Display, type FieldGroup } from "./format";

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

/** One key/value row: muted parent labels, then the key, then the value. */
export function FieldRow({ label, parents = [], path, children }: { label: string; parents?: string[]; path?: string; children: ReactNode }) {
  return (
    <div className="kv-row">
      <dt title={path}>
        {parents.map((p, i) => (
          <span key={i} className="kv-parent">
            {p}
            <span className="kv-sep" aria-hidden="true">›</span>
          </span>
        ))}
        <span className="kv-key">{label}</span>
      </dt>
      <dd>
        <span className="kv-value">{children}</span>
        {path ? <CopyButton text={path} label={`Copy path ${path}`} /> : null}
      </dd>
    </div>
  );
}

function Group({ group }: { group: FieldGroup }) {
  return (
    <div className="kv-group">
      {group.title ? (
        <div className="kv-group-title" title={group.path}>
          {group.title}
          <span className="kv-count">{group.rows.length}</span>
        </div>
      ) : null}
      <dl className="kv">
        {group.rows.map((r) => (
          <FieldRow key={r.path} label={r.label} parents={r.parents} path={r.path}>
            <ValueText display={r.display} />
          </FieldRow>
        ))}
      </dl>
    </div>
  );
}

/** The event as flat key/value groups (no nested boxes), plus a quiet raw JSON toggle. */
export function EventFields({ event, prefix = "payload" }: { event: Record<string, unknown>; prefix?: string }) {
  const [raw, setRaw] = useState(false);
  const json = JSON.stringify(event, null, 2);
  return (
    <section aria-label="Event data" className="event ad-panel">
      <div className="panel-head">
        <h2>Event</h2>
        <button type="button" className="link-btn" aria-expanded={raw} onClick={() => setRaw(!raw)}>
          {raw ? "Hide raw JSON" : "View raw JSON"}
        </button>
      </div>
      <div className="panel-body fields">
        {eventGroups(event, prefix).map((g) => (
          <Group key={g.path} group={g} />
        ))}
      </div>
      {raw ? (
        <div className="panel-body raw">
          <CopyButton text={json} label="Copy raw JSON" />
          <pre className="mono raw-json">{json}</pre>
        </div>
      ) : null}
    </section>
  );
}
