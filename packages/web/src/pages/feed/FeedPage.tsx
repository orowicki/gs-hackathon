import type { FilterNode } from "@alerting/filter";
import type { Alert, Person, StarredFilter } from "@alerting/shared";
import { Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Icon } from "../../components/Icon";
import { SettingsMenu } from "../../components/SettingsPanel";
import { withFilter } from "../../filterUrl";
import { AlertList, SkeletonRows } from "./AlertList";
import { createSource, isDemoSource } from "./data";
import type { FeedSource } from "./data";
import { FilterBar } from "../../components/filter-bar";
import {
  FEED_TABS,
  fieldNames,
  filterAlerts,
  mentionsStatus,
  newStarred,
  parseFilter,
  parseTab,
  starredTexts,
  tabAlerts,
  upsertAlert,
  valuesFor,
  type FeedTab,
} from "./helpers";
import { ProfilePicker, StarredList } from "./ProfilePicker";
import { StatPanels } from "./StatPanels";

const PROFILE_KEY = "alerting.profile";
const STARRED_KEY = "alerting.starred.";
const SCROLLED = 48;

function readLocal<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeLocal(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

export function FeedPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const q = params.get("q") ?? "";
  const tab = parseTab(params.get("tab"));
  const input = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLElement>(null);

  const [source, setSource] = useState<FeedSource | null>(null);
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(true);
  const [applied, setApplied] = useState(q);
  const [people, setPeople] = useState<Person[]>([]);
  const [profileId, setProfileId] = useState<string | null>(() => readLocal<string | null>(PROFILE_KEY, null));
  const [starred, setStarred] = useState<StarredFilter[]>([]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [flash, setFlash] = useState<ReadonlyMap<string, number>>(new Map());
  const [pending, setPending] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [suggested, setSuggested] = useState<string[]>([]);

  const tree = useMemo(() => {
    const r = parseFilter(applied);
    return r.ok ? r.tree : null;
  }, [applied]);
  // Keep showing the last valid result when the applied text is invalid.
  const [lastTree, setLastTree] = useState<FilterNode | null>(tree);
  const activeTree = parseFilter(applied).ok ? tree : lastTree;
  const applyText = useCallback((text: string) => {
    setApplied(text);
    const r = parseFilter(text);
    if (r.ok) setLastTree(r.tree);
  }, []);

  const matching = useMemo(() => filterAlerts(alerts ?? [], activeTree), [alerts, activeTree]);
  const statusInFilter = mentionsStatus(activeTree);
  const visible = useMemo(() => tabAlerts(matching, tab, activeTree), [matching, tab, activeTree]);
  const tabCounts = useMemo(
    () => Object.fromEntries(FEED_TABS.map((t) => [t.id, matching.filter((a) => a.state === t.state).length])) as Record<FeedTab, number>,
    [matching],
  );
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const visibleIds = useRef(new Set<string>());
  visibleIds.current = new Set(visible.map((a) => a.id));
  const treeRef = useRef(activeTree);
  treeRef.current = activeTree;

  // Source and first load.
  useEffect(() => {
    let cancelled = false;
    createSource(window.location.search)
      .then(async (s) => {
        const [list, ppl] = await Promise.all([s.listAlerts(), s.listPeople().catch(() => [])]);
        if (cancelled) return;
        setSource(s);
        setAlerts(list);
        setPeople(ppl);
        void s.suggestFields?.().then((f) => !cancelled && setSuggested(f));
      })
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : "Could not load alerts."));
    return () => {
      cancelled = true;
    };
  }, []);

  // Live updates.
  useEffect(() => {
    if (!source) return;
    let down = false;
    let stopped = false;
    const resync = () =>
      source
        .listAlerts()
        .then((list) => !stopped && setAlerts(list))
        .catch(() => undefined);
    const unsubscribe = source.subscribe(
      (push) => {
        if (push.type !== "alert" || !("alertId" in push)) return; // notification, event, dead_letter: not shown in the feed
        const { alertId, kind } = push;
        source
          .getAlert(alertId)
          .then((alert) => {
            setAlerts((prev) => upsertAlert(prev ?? [], alert));
            setFlash((prev) => new Map(prev).set(alert.id, Date.now()));
            const matches = tabAlerts(filterAlerts([alert], treeRef.current), tabRef.current, treeRef.current).length > 0;
            const el = scroller.current;
            if (matches && kind === "created" && el && el.scrollTop > SCROLLED) setPending((n) => n + 1);
          })
          .catch(() => void resync());
      },
      (isLive) => {
        setLive(isLive);
        if (!isLive) down = true;
        else if (down) {
          down = false;
          void resync(); // pick up alerts missed while disconnected
        }
      },
    );
    return () => {
      stopped = true;
      unsubscribe();
    };
  }, [source]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  // Profile and starred filters.
  const person = people.find((p) => p.id === profileId) ?? people[0] ?? null;
  const personId = person?.id ?? null;
  useEffect(() => {
    if (!source || !personId) return;
    let cancelled = false;
    source
      .getStarred(personId)
      .catch(() => readLocal<StarredFilter[]>(STARRED_KEY + personId, []))
      .then((list) => !cancelled && setStarred(list));
    return () => {
      cancelled = true;
    };
  }, [source, personId]);

  const saveStarred = useCallback(
    (next: StarredFilter[]) => {
      if (!personId) return;
      setStarred(next);
      writeLocal(STARRED_KEY + personId, next);
      void source?.putStarred(personId, next).catch(() => undefined);
    },
    [source, personId],
  );

  const toggleStar = (text: string) => {
    if (!personId) return;
    const hit = starred.find((s) => s.name === text);
    saveStarred(hit ? starred.filter((s) => s !== hit) : [...starred, newStarred(personId, text)]);
  };

  const selectProfile = (id: string) => {
    setProfileId(id);
    try {
      localStorage.setItem(PROFILE_KEY, id);
    } catch {
      /* ignore */
    }
  };

  const setQ = useCallback(
    (text: string) => setParams((p) => withFilter(p, text), { replace: true }),
    [setParams],
  );

  const setTab = useCallback(
    (next: FeedTab, clearFilter = false) =>
      setParams(
        (p) => {
          const n = clearFilter ? withFilter(p, "") : new URLSearchParams(p);
          if (next === "active") n.delete("tab");
          else n.set("tab", next);
          return n;
        },
        { replace: true },
      ),
    [setParams],
  );

  const ack = useCallback(
    async (id: string) => {
      if (!source?.ack) return;
      const updated = await source.ack(id);
      setAlerts((prev) => upsertAlert(prev ?? [], updated));
    },
    [source],
  );

  // "/" focuses the filter.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      e.preventDefault();
      input.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const toggle = useCallback((id: string, open?: boolean) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      const want = open ?? !next.has(id);
      if (want) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const onScroll = () => {
    if (pending > 0 && (scroller.current?.scrollTop ?? 0) <= SCROLLED) setPending(0);
  };
  const toTop = () => {
    scroller.current?.scrollTo({ top: 0 });
    setPending(0);
  };

  const fields = useMemo(() => fieldNames(alerts ?? [], suggested), [alerts, suggested]);
  const starredList = starredTexts(starred);
  const canCreate = person?.canCreateRules ?? false;

  const settings = {
    Profile: <ProfilePicker people={people} currentId={person?.id ?? null} onSelect={selectProfile} />,
    "Starred filters": (
      <StarredList
        starred={starred}
        onApply={(t) => {
          setQ(t);
          applyText(t);
        }}
        onRemove={(id) => saveStarred(starred.filter((s) => s.id !== id))}
      />
    ),
  };

  function body() {
    if (error) {
      return (
        <div className="empty" role="alert">
          <p>Could not load alerts.</p>
          <p className="muted">{error}</p>
          <button type="button" className="link-btn" onClick={() => window.location.reload()}>
            Try again
          </button>
        </div>
      );
    }
    if (!alerts) return <SkeletonRows />;
    if (alerts.length === 0) {
      return (
        <div className="empty">
          <p className="muted">No alerts yet.</p>
          {canCreate && <Link to="/rules/new">Create a rule</Link>}
        </div>
      );
    }
    if (visible.length === 0 && !q && !statusInFilter) {
      return (
        <div className="empty">
          <p className="muted">{tab === "active" ? "Nothing needs attention. All alerts are acknowledged or resolved." : "No acknowledged alerts."}</p>
        </div>
      );
    }
    if (visible.length === 0) {
      return (
        <div className="empty">
          <p className="muted">No alerts match this filter.</p>
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              setQ("");
              applyText("");
            }}
          >
            Clear filter
          </button>
        </div>
      );
    }
    return (
      <AlertList alerts={visible} now={now} expanded={expanded} onToggle={toggle} flash={flash} onAck={source?.ack ? ack : undefined} />
    );
  }

  return (
    <div className="feed-page">
      <header className="topbar">
        <SettingsMenu sections={settings} />
        <FilterBar
          value={q}
          onChange={setQ}
          onApply={applyText}
          fields={fields}
          valuesFor={(f) => valuesFor(alerts ?? [], f)}
          starred={starredList}
          onToggleStar={toggleStar}
          inputRef={input}
        />
        {canCreate && (
          <button type="button" className="icon-btn square" title="New rule" aria-label="New rule" onClick={() => navigate("/rules/new")}>
            <Icon as={Plus} />
          </button>
        )}
      </header>
      {alerts && alerts.length > 0 && (
        <StatPanels
          alerts={alerts}
          onFilter={(text) => {
            setParams((p) => {
              const n = withFilter(p, text);
              n.delete("tab");
              return n;
            }, { replace: true });
            applyText(text);
          }}
        />
      )}
      {alerts && alerts.length > 0 && (
        <nav className="feed-tabs" aria-label="Alert state">
          <div role="tablist">
            {FEED_TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={!statusInFilter && tab === t.id}
                className={!statusInFilter && tab === t.id ? "feed-tab active" : "feed-tab"}
                onClick={() => {
                  // A status filter overrides tabs; picking a tab drops it.
                  setTab(t.id, statusInFilter);
                  if (statusInFilter) applyText("");
                }}
              >
                {t.label}
                <span className="feed-tab-count">{tabCounts[t.id]}</span>
              </button>
            ))}
          </div>
          {statusInFilter ? (
            <span className="feed-tabs-note muted">Your filter picks the status, so all states are shown.</span>
          ) : (
            <button
              type="button"
              className="link-btn feed-tabs-note"
              onClick={() => {
                setQ("alert.status = resolved");
                applyText("alert.status = resolved");
              }}
            >
              Show resolved
            </button>
          )}
        </nav>
      )}
      {isDemoSource(source) && (
        <div className="live-bar" role="status">
          Demo data — API not reachable
        </div>
      )}
      {!live && (
        <div className="live-bar" role="status">
          Live updates paused — reconnecting…
        </div>
      )}
      <main className="feed" ref={scroller} onScroll={onScroll}>
        {pending > 0 && (
          <button type="button" className="new-pill" onClick={toTop}>
            {pending} new {pending === 1 ? "alert" : "alerts"}
          </button>
        )}
        {body()}
      </main>
    </div>
  );
}
