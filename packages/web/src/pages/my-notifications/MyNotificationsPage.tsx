import { useCurrentPerson } from "../../account";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { BellRing, Mail, MessageSquare, Monitor, Moon, Route, Smartphone, type LucideIcon } from "lucide-react";
import type { ChannelId, Severity } from "../../../../shared/src/types/common";
import type { ChannelStatus } from "../../../../shared/src/types/notification";
import type { Group, Person, PreferenceRule } from "../../../../shared/src/types/people";
import type { Rule } from "../../../../shared/src/types/rule";
import { Icon } from "../../components/Icon";
import { getPreference, listChannels, listGroups, listPeople, listRules, putPreference } from "./api";
import {
  CHANNELS,
  SEVERITY_ROWS,
  defaultGrid,
  defaultQuiet,
  gridFromPreference,
  parseStoredProfile,
  preferenceFromForm,
  quietFromPreference,
  validateQuiet,
  type Grid,
  type QuietForm,
} from "./grid";
import { effectiveNow, quietActiveAt, quietSegments, rulesReaching, timezones } from "./insights";
import "./my-notifications.css";
import { channelLabel } from "../../channels";

const PROFILE_KEY = "alerting.profile";

const CHANNEL_ICONS: Record<string, LucideIcon> = { ui: Monitor, ntfy: Smartphone, email: Mail, sms: MessageSquare };
const channelIcon = (c: ChannelId): LucideIcon => CHANNEL_ICONS[c] ?? BellRing;

const SEVERITY_TEXT: Record<Severity, string> = {
  critical: "Critical",
  error: "Error",
  warning: "Warning",
  info: "Info",
};

function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function toggle(list: ChannelId[], c: ChannelId, on: boolean): ChannelId[] {
  return on ? (list.includes(c) ? list : [...list, c]) : list.filter((x) => x !== c);
}

/** Where a channel delivers to for this person, in plain words. */
function destination(c: ChannelId, person: Person): string {
  if (c === "ui") return "The alert feed in this app, live";
  if (c === "ntfy") return person.ntfyTopic ? `Push to the ntfy app, topic ${person.ntfyTopic}` : "Not set up: no phone topic yet";
  if (c === "email") return "Email (the demo mail server catches it)";
  return "Delivery channel";
}

/** Whether the person can receive on a channel at all. */
const usable = (c: ChannelId, person: Person): boolean => c !== "ntfy" || Boolean(person.ntfyTopic);

const snapshot = (grid: Grid, quiet: QuietForm) => JSON.stringify({ grid, quiet });

export function MyNotificationsPage() {
  const tz = useMemo(browserTimezone, []);
  const [people, setPeople] = useState<Person[] | undefined>();
  const [peopleError, setPeopleError] = useState<string | undefined>();
  const [storedId, setPersonId] = useState<string | undefined>(() => parseStoredProfile(localStorage.getItem(PROFILE_KEY)));
  // The signed-in account's notifications; the stored profile is the fallback without accounts.
  const personId = useCurrentPerson()?.id ?? storedId;
  const [statuses, setStatuses] = useState<ChannelStatus[] | null | undefined>();
  const [rules, setRules] = useState<Rule[] | null | undefined>();
  const [groups, setGroups] = useState<Group[]>([]);
  const [grid, setGrid] = useState<Grid>(() => defaultGrid());
  const [quiet, setQuiet] = useState<QuietForm>(() => defaultQuiet(tz));
  const [baseline, setBaseline] = useState<string>(() => snapshot(defaultGrid(), defaultQuiet(tz)));
  const [lossy, setLossy] = useState(false);
  const [defaultsHint, setDefaultsHint] = useState(false);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [saveError, setSaveError] = useState<string | undefined>();
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [extraRules, setExtraRules] = useState<PreferenceRule[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    listPeople()
      .then(setPeople)
      .catch((e: Error) => setPeopleError(e.message));
    listChannels()
      .then(setStatuses)
      .catch(() => setStatuses(null));
    listRules()
      .then(setRules)
      .catch(() => setRules(null));
    listGroups()
      .then(setGroups)
      .catch(() => setGroups([]));
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  // Columns: every registered channel (GET /api/channels), the built-ins when that is unavailable.
  const channels = useMemo<ChannelId[]>(() => {
    const ids = statuses?.map((s) => s.id) ?? [];
    return ids.length > 0 ? [...new Set(["ui", ...ids])] : CHANNELS;
  }, [statuses]);

  const person = people?.find((p) => p.id === personId);
  const known = Boolean(person);

  useEffect(() => {
    if (!people || !person || statuses === undefined) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(undefined);
    setSaved(false);
    getPreference(person.id)
      .then((pref) => {
        if (cancelled) return;
        let g: Grid;
        let q: QuietForm;
        if (!pref) {
          g = defaultGrid(person);
          q = defaultQuiet(tz);
          setLossy(false);
          setExtraRules([]);
          setDefaultsHint(true);
        } else {
          const r = gridFromPreference(pref, channels);
          g = r.grid;
          q = quietFromPreference(pref, tz);
          setLossy(r.lossy);
          setExtraRules(r.extraRules);
          setDefaultsHint(false);
        }
        setGrid(g);
        setQuiet(q);
        setBaseline(snapshot(g, q));
      })
      .catch((e: Error) => {
        if (!cancelled) setLoadError(`Could not load preferences: ${e.message}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // channels is derived from statuses, which is in the list.
  }, [people, person?.id, tz, reloadKey, statuses]);

  const quietError = validateQuiet(quiet);
  const gridDisabled = loading || Boolean(loadError);
  const dirty = snapshot(grid, quiet) !== baseline;
  const canSave = Boolean(person) && !gridDisabled && !quietError && !saving && (dirty || defaultsHint);

  const zoneList = useMemo(() => timezones(quiet.timezone), [quiet.timezone]);
  const quietNow = quietActiveAt(quiet, now);
  const rightNow = effectiveNow(grid, quiet, now);
  const reach = useMemo(() => (person && rules ? rulesReaching(rules, groups, person.id) : []), [person, rules, groups]);

  function chooseProfile(id: string) {
    if (id) {
      localStorage.setItem(PROFILE_KEY, id);
      setPersonId(id);
    }
  }

  async function save() {
    if (!person || !canSave) return;
    setSaveError(undefined);
    setSaved(false);
    setSaving(true);
    try {
      await putPreference(person.id, preferenceFromForm(person.id, grid, quiet, extraRules, channels));
      setSaved(true);
      setLossy(false);
      setDefaultsHint(false);
      setBaseline(snapshot(grid, quiet));
    } catch (e) {
      setSaveError(`Could not save: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  function discard() {
    const { grid: g, quiet: q } = JSON.parse(baseline) as { grid: Grid; quiet: QuietForm };
    setGrid(g);
    setQuiet(q);
    setSaved(false);
    setSaveError(undefined);
  }

  const setCell = (sev: Severity, c: ChannelId, on: boolean) => {
    setSaved(false);
    setGrid((g) => ({ ...g, [sev]: toggle(g[sev], c, on) }));
  };
  const patchQuiet = (p: Partial<QuietForm>) => {
    setSaved(false);
    setQuiet((q) => ({ ...q, ...p }));
  };
  const applyPreset = (g: Grid) => {
    setSaved(false);
    setGrid(g);
  };

  const status = (c: ChannelId) => statuses?.find((s) => s.id === c);

  return (
    <main className="page my-notifications">
      <div className="page-header">
        <div>
          <h1>Notification preferences</h1>
          <p className="page-intro">
            {person ? (
              <>
                How <strong>{person.name}</strong> gets alerts: which channels for which severity, and when to stay quiet.
              </>
            ) : (
              "How you get alerts: which channels for which severity, and when to stay quiet."
            )}
          </p>
        </div>
        {person && (
          <div className="page-actions np-actions">
            {saved && !dirty && (
              <span role="status" className="np-saved">
                Saved
              </span>
            )}
            {dirty && <span className="tag np-dirty">Unsaved changes</span>}
            {dirty && (
              <button type="button" className="btn" onClick={discard} disabled={saving}>
                Discard
              </button>
            )}
            <button type="button" className="btn primary" onClick={() => void save()} disabled={!canSave}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        )}
      </div>

      {peopleError && (
        <p role="alert" className="np-error">
          Could not load people: {peopleError}
        </p>
      )}

      {people && !known && (
        <section className="np-panel">
          <label className="np-field">
            <span>Profile</span>
            <select value="" onChange={(e) => chooseProfile(e.target.value)}>
              <option value="">Select a person</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        </section>
      )}

      {person && (
        <>
          {loadError && (
            <p role="alert" className="np-error">
              {loadError}{" "}
              <button type="button" className="btn" onClick={() => setReloadKey((k) => k + 1)}>
                Retry
              </button>
            </p>
          )}
          {saveError && (
            <p role="alert" className="np-error">
              {saveError}
            </p>
          )}
          {defaultsHint && (
            <p className="callout np-callout">
              No preferences saved yet, so the defaults apply: the alert feed for everything, and your phone for error and critical
              when you have a phone topic. Save to keep them, or change them below.
            </p>
          )}
          {lossy && (
            <p className="callout np-callout warn">
              Some of your rules were written by hand (YAML or API) and can't be shown in the grid. They are kept and apply after the
              grid.
            </p>
          )}

          {/* Right now: what each severity would reach at this moment. */}
          <section className="np-panel" aria-labelledby="np-now">
            <header className="np-panel-head">
              <h2 id="np-now">Right now</h2>
              <span className={quietNow ? "tag np-quiet-on" : "tag ok"}>
                <Icon as={quietNow ? Moon : BellRing} />
                {quietNow ? `Quiet hours until ${quiet.to}` : "Notifications on"}
              </span>
            </header>
            <div className="np-now">
              {SEVERITY_ROWS.map((sev) => {
                const { channels: on, held } = rightNow[sev];
                return (
                  <div key={sev} className={`np-now-tile sev-${sev}`}>
                    <span className={`tag sev-${sev}`}>{SEVERITY_TEXT[sev]}</span>
                    <span className="np-now-channels">
                      {on.length === 0 ? (
                        <span className="muted">Nowhere</span>
                      ) : (
                        on.map((c) => (
                          <span key={c} className="np-chan" title={channelLabel(c)}>
                            <Icon as={channelIcon(c)} />
                            {channelLabel(c)}
                          </span>
                        ))
                      )}
                    </span>
                    {held.length > 0 && <span className="np-held muted">Held back: {held.map(channelLabel).join(", ")}</span>}
                  </div>
                );
              })}
            </div>
          </section>

          {/* Policy: severity × channel. */}
          <section className="np-panel" aria-labelledby="np-policy">
            <header className="np-panel-head">
              <div>
                <h2 id="np-policy">Notification policy</h2>
                <p className="np-panel-intro">Each row is one severity: switch on the channels you want those alerts on.</p>
              </div>
              <div className="np-presets" role="group" aria-label="Presets">
                <button type="button" className="btn" disabled={gridDisabled} onClick={() => applyPreset(defaultGrid(person))}>
                  Recommended
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={gridDisabled}
                  onClick={() => applyPreset({ critical: ["ui"], error: ["ui"], warning: ["ui"], info: ["ui"] })}
                >
                  Feed only
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={gridDisabled}
                  onClick={() =>
                    applyPreset({
                      critical: channels.filter((c) => usable(c, person)),
                      error: ["ui"],
                      warning: ["ui"],
                      info: [],
                    })
                  }
                >
                  Critical everywhere
                </button>
              </div>
            </header>
            <div className="np-table-wrap">
              <table className="np-grid">
                <thead>
                  <tr>
                    <th scope="col">Severity</th>
                    {channels.map((c) => (
                      <th key={c} scope="col">
                        <span className="np-chan-head">
                          <Icon as={channelIcon(c)} />
                          {channelLabel(c)}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {SEVERITY_ROWS.map((sev) => (
                    <tr key={sev}>
                      <th scope="row">
                        <span className={`np-sev-bar sev-${sev}`} aria-hidden="true" />
                        {SEVERITY_TEXT[sev]}
                      </th>
                      {channels.map((c) => (
                        <td key={c}>
                          <label className="switch np-switch">
                            <input
                              type="checkbox"
                              aria-label={`${sev} via ${channelLabel(c)}`}
                              checked={grid[sev].includes(c)}
                              disabled={gridDisabled || !usable(c, person)}
                              onChange={(e) => setCell(sev, c, e.target.checked)}
                            />
                            <span className="switch-track" aria-hidden="true" />
                          </label>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* Quiet hours. */}
          <section className="np-panel" aria-labelledby="np-quiet">
            <header className="np-panel-head">
              <div>
                <h2 id="np-quiet">Quiet hours</h2>
                <p className="np-panel-intro">During quiet hours only the channels you allow below are used; the rest wait.</p>
              </div>
              <label className="switch">
                <input type="checkbox" checked={quiet.enabled} onChange={(e) => patchQuiet({ enabled: e.target.checked })} />
                <span className="switch-track" aria-hidden="true" />
                <span>Enable quiet hours</span>
              </label>
            </header>
            {quiet.enabled && (
              <div className="np-quiet">
                <div className="np-row">
                  <label className="np-field">
                    <span>From</span>
                    <input type="time" value={quiet.from} onChange={(e) => patchQuiet({ from: e.target.value })} />
                  </label>
                  <label className="np-field">
                    <span>To</span>
                    <input type="time" value={quiet.to} onChange={(e) => patchQuiet({ to: e.target.value })} />
                  </label>
                  <label className="np-field np-tz">
                    <span>Timezone</span>
                    <select value={quiet.timezone} onChange={(e) => patchQuiet({ timezone: e.target.value })}>
                      {zoneList.map((z) => (
                        <option key={z} value={z}>
                          {z.replaceAll("_", " ")}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <div className="np-timeline" aria-hidden="true">
                  {quietSegments(quiet).map(([a, b], i) => (
                    <span key={i} className="np-timeline-quiet" style={{ left: `${a * 100}%`, width: `${(b - a) * 100}%` }} />
                  ))}
                  <span className="np-timeline-ticks">
                    <span>00:00</span>
                    <span>06:00</span>
                    <span>12:00</span>
                    <span>18:00</span>
                    <span>24:00</span>
                  </span>
                </div>

                <div className="np-row np-allow">
                  <span className="muted">Still allowed during quiet hours</span>
                  <div className="toggles">
                    {channels.map((c) => {
                      const on = quiet.allowChannels.includes(c);
                      return (
                        <button
                          key={c}
                          type="button"
                          className={on ? "toggle on" : "toggle"}
                          aria-pressed={on}
                          aria-label={`allow ${channelLabel(c)} during quiet hours`}
                          disabled={!usable(c, person)}
                          onClick={() => patchQuiet({ allowChannels: toggle(quiet.allowChannels, c, !on) })}
                        >
                          <Icon as={channelIcon(c)} /> {channelLabel(c)}
                        </button>
                      );
                    })}
                  </div>
                </div>
                {quietError && (
                  <p role="alert" className="np-error">
                    {quietError}
                  </p>
                )}
              </div>
            )}
          </section>

          {/* Contact points: every registered channel, where it goes and whether it is healthy. */}
          <section className="np-panel" aria-labelledby="np-contacts">
            <header className="np-panel-head">
              <div>
                <h2 id="np-contacts">Contact points</h2>
                <p className="np-panel-intro">Every channel the service can deliver on, and where it reaches you.</p>
              </div>
              <Link className="btn" to="/config/channels">
                Channel health
              </Link>
            </header>
            <ul className="np-contacts">
              {channels.map((c) => {
                const s = status(c);
                const ok = usable(c, person);
                return (
                  <li key={c} className={ok ? "np-contact" : "np-contact off"}>
                    <span className="np-contact-icon">
                      <Icon as={channelIcon(c)} />
                    </span>
                    <span className="np-contact-main">
                      <span className="np-contact-name">{channelLabel(c)}</span>
                      <span className="muted">{destination(c, person)}</span>
                    </span>
                    {!ok ? (
                      <Link className="btn" to="/config/people">
                        Add a phone topic
                      </Link>
                    ) : s ? (
                      <span className={s.healthy ? "tag ok" : "tag sev-error"} title={s.lastError ?? undefined}>
                        {s.healthy ? "Healthy" : "Problem"}
                        {s.pending > 0 ? ` · ${s.pending} pending` : ""}
                        {s.deadLetters > 0 ? ` · ${s.deadLetters} failed` : ""}
                      </span>
                    ) : (
                      <span className="tag">Status unknown</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>

          {/* Which rules can notify this person, and how. */}
          <section className="np-panel" aria-labelledby="np-rules">
            <header className="np-panel-head">
              <div>
                <h2 id="np-rules">Rules that notify you</h2>
                <p className="np-panel-intro">Alerts reach you only through these rules, directly or through a group you are in.</p>
              </div>
              <Icon as={Route} />
            </header>
            {rules === undefined ? (
              <p className="muted">Loading rules…</p>
            ) : rules === null ? (
              <p className="muted">Couldn't load the rules.</p>
            ) : reach.length === 0 ? (
              <p className="muted">
                No rule sends alerts to you yet. Ask someone who can edit rules to add you, or add you to a group in{" "}
                <Link to="/config/people">People &amp; groups</Link>.
              </p>
            ) : (
              <ul className="np-rules">
                {reach.map(({ rule, via, forced }) => (
                  <li key={rule.id} className={rule.enabled ? "np-rule" : "np-rule off"}>
                    <Link to={`/rules/${encodeURIComponent(rule.id)}`} className="np-rule-name">
                      {rule.name}
                    </Link>
                    <span className="muted">{via.map((v) => (v === "you" ? "You directly" : `Group ${v}`)).join(", ")}</span>
                    {!rule.enabled && <span className="tag">Disabled</span>}
                    {forced.length > 0 && (
                      <span className="tag sev-warning" title="This rule overrides your preferences on these channels">
                        Always: {forced.map(channelLabel).join(", ")}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </main>
  );
}
