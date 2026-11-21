import type { Alert } from "@alerting/shared";
import { ChevronRight } from "lucide-react";
import { useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Icon } from "../../components/Icon";
import { relativeTime, severityLabel } from "./helpers";

interface ListProps {
  alerts: Alert[];
  now: number;
  expanded: ReadonlySet<string>;
  onToggle(id: string, open?: boolean): void;
  /** Alert id to a token that changes on every update; drives the highlight animation. */
  flash: ReadonlyMap<string, number>;
  /** Acknowledge from the expanded row; omitted = no button. */
  onAck?(id: string): Promise<void>;
  /** Unacknowledge (back to open) from the expanded row; omitted = no button. */
  onUnack?(id: string): Promise<void>;
}

export function AlertList({ alerts, now, expanded, onToggle, flash, onAck, onUnack }: ListProps) {
  const navigate = useNavigate();
  const root = useRef<HTMLUListElement>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const activeId = alerts.some((a) => a.id === focusId) ? focusId : (alerts[0]?.id ?? null);

  function move(from: HTMLElement, delta: number) {
    const heads = Array.from(root.current?.querySelectorAll<HTMLElement>("[data-row-head]") ?? []);
    const target = heads[heads.indexOf(from) + delta];
    if (target) target.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLElement>, id: string, open: boolean) {
    if (e.target !== e.currentTarget || e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key) {
      case "ArrowDown":
        move(e.currentTarget, 1);
        break;
      case "ArrowUp":
        move(e.currentTarget, -1);
        break;
      case "ArrowRight":
        onToggle(id, true);
        break;
      case "ArrowLeft":
        onToggle(id, false);
        break;
      case "Enter":
        onToggle(id, !open);
        break;
      case "o":
        navigate("/alerts/" + encodeURIComponent(id));
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  return (
    <ul className="alert-list" ref={root}>
      {alerts.map((a) => {
        const open = expanded.has(a.id);
        const token = flash.get(a.id);
        return (
          <li key={a.id} className={"row sev-" + a.severity + " state-" + a.state}>
            <div
              className="row-head"
              role="button"
              data-row-head
              tabIndex={a.id === activeId ? 0 : -1}
              aria-expanded={open}
              onFocus={() => setFocusId(a.id)}
              onClick={() => onToggle(a.id)}
              onKeyDown={(e) => onKeyDown(e, a.id, open)}
            >
              {token !== undefined && <span key={token} className="row-flash" aria-hidden="true" />}
              <span className="sev-bar" aria-hidden="true" />
              <span className="sev-label">{severityLabel(a.severity)}</span>
              <span className={open ? "chevron open" : "chevron"}>
                <Icon as={ChevronRight} />
              </span>
              {a.state !== "open" && (
                <span className="state-tag">{a.state === "acknowledged" ? "Acknowledged" : "Resolved"}</span>
              )}
              <span className="row-title">{a.title}</span>
              <span className="row-source muted">{a.source}</span>
              <time className="row-time muted" dateTime={a.lastSeen} title={new Date(a.lastSeen).toLocaleString()}>
                {relativeTime(a.lastSeen, now)}
              </time>
              <span className="row-count muted">{a.count > 1 ? "×" + a.count : ""}</span>
            </div>
            {open && <RowDetails alert={a} onAck={onAck} onUnack={onUnack} />}
          </li>
        );
      })}
    </ul>
  );
}

function RowDetails({
  alert: a,
  onAck,
  onUnack,
}: {
  alert: Alert;
  onAck?(id: string): Promise<void>;
  onUnack?(id: string): Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (action: ((id: string) => Promise<void>) | undefined, failed: string) => {
    if (!action) return;
    setBusy(true);
    setError(null);
    action(a.id)
      .then(() => setBusy(false))
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : failed);
        setBusy(false);
      });
  };
  const when = (iso: string) => new Date(iso).toLocaleString();
  const facts: Array<[string, string]> = [
    ["Summary", a.body ?? a.title],
    ["Environment", a.environment],
    ["Type", a.schemaId ?? "unknown"],
    ["Status", a.state],
    ["First seen", when(a.firstSeen)],
    ["Last seen", when(a.lastSeen)],
    ...a.fields.map((f): [string, string] => [f.label, f.value]),
  ];
  return (
    <div className="row-body">
      <dl>
        {facts.map(([label, value], i) => (
          <div key={i} className="fact">
            <dt className="muted">{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <div className="row-actions">
        {onAck && a.state === "open" && (
          <button type="button" className="row-ack" disabled={busy} onClick={() => run(onAck, "Could not acknowledge.")}>
            Acknowledge
          </button>
        )}
        {onUnack && a.state === "acknowledged" && (
          <button
            type="button"
            className="row-ack"
            title="Move the alert back to open"
            disabled={busy}
            onClick={() => run(onUnack, "Could not unacknowledge.")}
          >
            Unacknowledge
          </button>
        )}
        <Link className="row-open" to={"/alerts/" + encodeURIComponent(a.id)}>
          Open
        </Link>
        {error && (
          <span className="row-error" role="alert">
            {error}
          </span>
        )}
      </div>
    </div>
  );
}

export function SkeletonRows() {
  return (
    <div className="alert-list" aria-busy="true" aria-label="Loading alerts">
      {Array.from({ length: 7 }, (_, i) => (
        <div key={i} className="row skeleton">
          <span className="skeleton-bar" style={{ width: 120 + ((i * 53) % 160) }} />
        </div>
      ))}
    </div>
  );
}
