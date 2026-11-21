import type { Event } from "@alerting/shared";
import { ChevronDown, ChevronRight, FilePlus2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Icon } from "../../components/Icon";
import { relativeTime } from "../feed/helpers";
import "./events.css";

const UNRECOGNISED = "NOT alert.schema matches *";
const PAGE = 100;

interface Named {
  id: string;
  name: string;
}

function summaryOf(e: Event): string {
  if (typeof e.common?.title === "string" && e.common.title) return e.common.title;
  // First few leaf values, nested ones included (labels.service=...), so no row is blank.
  const out: string[] = [];
  const walk = (o: unknown, prefix: string) => {
    if (out.length >= 4) return;
    if (o && typeof o === "object" && !Array.isArray(o)) for (const [k, v] of Object.entries(o)) walk(v, prefix ? `${prefix}.${k}` : k);
    else if (o !== null && o !== undefined && prefix) out.push(`${prefix}=${typeof o === "string" ? o : JSON.stringify(o)}`);
  };
  walk(e.parsed ?? {}, "");
  return out.join("  ");
}

function sampleOf(e: Event): string {
  const v = e.parsed && Object.keys(e.parsed).length ? e.parsed : e.raw;
  return typeof v === "string" ? v : JSON.stringify(v, null, 2);
}

function Fields({ obj }: { obj: Record<string, unknown> }) {
  const flat: [string, unknown][] = [];
  const walk = (o: unknown, prefix: string) => {
    if (o && typeof o === "object" && !Array.isArray(o)) {
      for (const [k, v] of Object.entries(o)) walk(v, prefix ? `${prefix}.${k}` : k);
    } else flat.push([prefix, o]);
  };
  walk(obj, "");
  return (
    <dl className="ev-fields">
      {flat.map(([k, v]) => (
        <div key={k}>
          <dt title={k}>{k}</dt>
          <dd>{typeof v === "string" ? v : JSON.stringify(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Alerts > Events: everything arriving from the sources, newest first (GET /api/events),
 * like Grafana Explore's log view. Events no schema recognised are flagged, and one click
 * turns one into a new schema with the event as its sample.
 */
export function EventsPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const show = params.get("show") === "unrecognised" ? "unrecognised" : "all";
  const sourceId = params.get("source") ?? "";
  const [events, setEvents] = useState<Event[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [auto, setAuto] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const [sources, setSources] = useState<Named[]>([]);
  const [schemas, setSchemas] = useState<Named[]>([]);


  const load = useCallback(
    async (before?: string) => {
      setError("");
      try {
        const r = await fetch(`/api/events?limit=${PAGE}&filter=${encodeURIComponent(show === "unrecognised" ? UNRECOGNISED : "")}${before ? `&before=${encodeURIComponent(before)}` : ""}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const page = ((await r.json()) as Event[]).filter((e) => !sourceId || e.sourceId === sourceId);
        setNext(r.headers.get("x-next-before"));
        setEvents((cur) => (before && cur ? [...cur, ...page] : page));
        setNow(Date.now());
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [show, sourceId],
  );

  // The event filter can't see an event's source, so the source picker filters here.
  useEffect(() => {
    setEvents(null);
    void load();
  }, [load]);

  // Live: refresh the first page every 5 s (only while the list is at the top).
  useEffect(() => {
    if (!auto) return;
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [auto, load]);

  useEffect(() => {
    fetch("/api/sources")
      .then((r) => (r.ok ? (r.json() as Promise<Named[]>) : []))
      .then(setSources)
      .catch(() => undefined);
    fetch("/api/schemas")
      .then((r) => (r.ok ? (r.json() as Promise<Named[]>) : []))
      .then(setSchemas)
      .catch(() => undefined);
  }, []);

  const nameOf = (list: Named[], id: string) => list.find((x) => x.id === id)?.name ?? id;
  const set = (k: string, v: string) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (v) n.set(k, v);
        else n.delete(k);
        return n;
      },
      { replace: true },
    );
  const toggle = (id: string) =>
    setOpen((cur) => {
      const n = new Set(cur);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const createSchema = (e: Event) =>
    navigate("/config/schemas/new?mode=editor&from=event", {
      state: { fromEvent: { sample: sampleOf(e), source: nameOf(sources, e.sourceId) } },
    });

  return (
    <main className="page ev-page">
      <header className="page-header">
        <div>
          <h1>Events</h1>
          <p className="page-intro">
            Everything arriving from your sources, newest first. Events no schema recognises can't become proper alerts: turn one into a schema in one
            click.
          </p>
        </div>
      </header>

      <div className="ev-toolbar">
        <div className="segmented-sm" role="radiogroup" aria-label="Show">
          {(
            [
              ["all", "All events"],
              ["unrecognised", "Not recognised"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={show === id}
              className={show === id ? "seg on" : "seg"}
              onClick={() => set("show", id === "all" ? "" : id)}
            >
              {label}
            </button>
          ))}
        </div>
        <select aria-label="Source" value={sourceId} onChange={(e) => set("source", e.target.value)}>
          <option value="">All sources</option>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <span className="ev-spacer" />
        <label className="switch">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          <span className="switch-track" aria-hidden="true" />
          Live
        </label>
        <button type="button" className="btn" onClick={() => void load()}>
          <Icon as={RefreshCw} /> Refresh
        </button>
      </div>

      {error && (
        <p role="alert" className="callout error">
          Couldn't load events: {error}
        </p>
      )}
      {events === null && !error && <p className="muted">Loading events…</p>}
      {events?.length === 0 && (
        <div className="empty-state">
          <p>{show === "unrecognised" ? "Every recent event is recognised by a schema." : "No events yet. Send one to a source, or run just demo."}</p>
        </div>
      )}

      {events && events.length > 0 && (
        <ul className="ev-list" aria-label="Events">
          {events.map((e) => {
            const isOpen = open.has(e.id);
            return (
              <li key={e.id} className={isOpen ? "ev-row open" : "ev-row"}>
                <button type="button" className="ev-head" aria-expanded={isOpen} onClick={() => toggle(e.id)}>
                  <Icon as={isOpen ? ChevronDown : ChevronRight} />
                  <span className="ev-time" title={new Date(e.receivedAt).toLocaleString()}>
                    {relativeTime(e.receivedAt, now)}
                  </span>
                  <span className="ev-source">{nameOf(sources, e.sourceId)}</span>
                  {e.schemaId ? <span className="tag">{nameOf(schemas, e.schemaId)}</span> : <span className="tag ev-unrec">Not recognised</span>}
                  <span className="ev-summary mono">{summaryOf(e)}</span>
                </button>
                {isOpen && (
                  <div className="ev-body">
                    <div className="ev-actions">
                      {e.schemaId ? (
                        <Link className="btn" to={`/config/schemas/${encodeURIComponent(e.schemaId)}`}>
                          Open schema
                        </Link>
                      ) : (
                        <button type="button" className="btn primary" onClick={() => createSchema(e)}>
                          <Icon as={FilePlus2} /> Create schema from this event
                        </button>
                      )}
                      <span className="muted ev-id mono">{e.id}</span>
                    </div>
                    <div className="ev-cols">
                      <section aria-label="Parsed fields">
                        <h3>Fields</h3>
                        <Fields obj={(e.parsed ?? {}) as Record<string, unknown>} />
                      </section>
                      <section aria-label="Raw event">
                        <h3>Raw</h3>
                        <pre className="code-block">{typeof e.raw === "string" ? e.raw : JSON.stringify(e.raw, null, 2)}</pre>
                      </section>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {next && events && events.length > 0 && (
        <button type="button" className="btn ev-more" onClick={() => void load(next)}>
          Load older events
        </button>
      )}
    </main>
  );
}
