import { useEffect, useMemo, useState } from "react";
import type { ChannelId, Severity } from "../../../../shared/src/types/common";
import type { Person, PreferenceRule } from "../../../../shared/src/types/people";
import { getPreference, listPeople, putPreference } from "./api";
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
import "./my-notifications.css";

const PROFILE_KEY = "alerting.profile";

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

export function MyNotificationsPage() {
  const tz = useMemo(browserTimezone, []);
  const [people, setPeople] = useState<Person[] | undefined>();
  const [peopleError, setPeopleError] = useState<string | undefined>();
  const [personId, setPersonId] = useState<string | undefined>(() => parseStoredProfile(localStorage.getItem(PROFILE_KEY)));
  const [grid, setGrid] = useState<Grid>(() => defaultGrid());
  const [quiet, setQuiet] = useState<QuietForm>(() => defaultQuiet(tz));
  const [lossy, setLossy] = useState(false);
  const [defaultsHint, setDefaultsHint] = useState(false);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [saveError, setSaveError] = useState<string | undefined>();
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(false);
  const [extraRules, setExtraRules] = useState<PreferenceRule[]>([]);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    listPeople()
      .then(setPeople)
      .catch((e: Error) => setPeopleError(e.message));
  }, []);

  const person = people?.find((p) => p.id === personId);
  const known = Boolean(person);

  useEffect(() => {
    if (!people || !person) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(undefined);
    setSaved(false);
    getPreference(person.id)
      .then((pref) => {
        if (cancelled) return;
        if (!pref) {
          setGrid(defaultGrid(person));
          setQuiet(defaultQuiet(tz));
          setLossy(false);
          setExtraRules([]);
          setDefaultsHint(true);
        } else {
          const r = gridFromPreference(pref);
          setGrid(r.grid);
          setLossy(r.lossy);
          setExtraRules(r.extraRules);
          setQuiet(quietFromPreference(pref, tz));
          setDefaultsHint(false);
        }
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
  }, [people, person?.id, tz, reloadKey]);

  const quietError = validateQuiet(quiet);
  const gridDisabled = loading || Boolean(loadError);

  function chooseProfile(id: string) {
    if (id) {
      localStorage.setItem(PROFILE_KEY, id);
      setPersonId(id);
    }
  }

  async function save() {
    if (!person || quietError || loadError || loading) return;
    setSaveError(undefined);
    setSaved(false);
    try {
      await putPreference(person.id, preferenceFromForm(person.id, grid, quiet, extraRules));
      setSaved(true);
      setLossy(false);
      setDefaultsHint(false);
    } catch (e) {
      setSaveError(`Could not save: ${(e as Error).message}`);
    }
  }

  const setCell = (sev: Severity, c: ChannelId, on: boolean) => {
    setSaved(false);
    setGrid((g) => ({ ...g, [sev]: toggle(g[sev], c, on) }));
  };
  const patchQuiet = (p: Partial<QuietForm>) => {
    setSaved(false);
    setQuiet((q) => ({ ...q, ...p }));
  };

  return (
    <main className="page my-notifications">
      <h1>My notifications</h1>

      {peopleError && <p role="alert" className="mn-error">Could not load people: {peopleError}</p>}

      {people && !known && (
        <label className="mn-field">
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
      )}

      {person && (
        <>
          <p className="muted">
            Editing preferences for <strong>{person.name}</strong>
          </p>
          {loadError && (
            <p role="alert" className="mn-error">
              {loadError}{" "}
              <button type="button" onClick={() => setReloadKey((k) => k + 1)}>
                Retry
              </button>
            </p>
          )}
          {defaultsHint && (
            <p className="muted">
              No preferences saved yet. Defaults apply: ui always, ntfy for error and critical when you have an ntfy topic.
            </p>
          )}
          {lossy && <p className="mn-note">Some rules can't be shown in the grid; they are kept after the grid rules.</p>}

          {!person.ntfyTopic && <p className="muted">Set an ntfy topic in People &amp; groups to use ntfy</p>}

          <table className="mn-grid">
            <thead>
              <tr>
                <th scope="col">Severity</th>
                {CHANNELS.map((c) => (
                  <th key={c} scope="col">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {SEVERITY_ROWS.map((sev) => (
                <tr key={sev}>
                  <th scope="row" style={{ color: `var(--${sev})` }}>
                    {sev}
                  </th>
                  {CHANNELS.map((c) => (
                    <td key={c}>
                      <input
                        type="checkbox"
                        aria-label={`${sev} via ${c}`}
                        checked={grid[sev].includes(c)}
                        disabled={gridDisabled || (c === "ntfy" && !person.ntfyTopic)}
                        onChange={(e) => setCell(sev, c, e.target.checked)}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>

          <fieldset className="mn-quiet">
            <legend>Quiet hours</legend>
            <label className="mn-inline">
              <input
                type="checkbox"
                checked={quiet.enabled}
                onChange={(e) => patchQuiet({ enabled: e.target.checked })}
              />
              <span>Enable quiet hours</span>
            </label>
            {quiet.enabled && (
              <>
                <div className="mn-row">
                  <label className="mn-field">
                    <span>From</span>
                    <input
                      type="text"
                      inputMode="numeric"
                      placeholder="HH:MM"
                      value={quiet.from}
                      onChange={(e) => patchQuiet({ from: e.target.value })}
                    />
                  </label>
                  <label className="mn-field">
                    <span>To</span>
                    <input
                      type="text"
                      inputMode="numeric"
                      placeholder="HH:MM"
                      value={quiet.to}
                      onChange={(e) => patchQuiet({ to: e.target.value })}
                    />
                  </label>
                  <label className="mn-field">
                    <span>Timezone</span>
                    <input type="text" value={quiet.timezone} onChange={(e) => patchQuiet({ timezone: e.target.value })} />
                  </label>
                </div>
                <div className="mn-row">
                  <span className="muted">Still allowed during quiet hours:</span>
                  {CHANNELS.map((c) => (
                    <label key={c} className="mn-inline">
                      <input
                        type="checkbox"
                        aria-label={`allow ${c} during quiet hours`}
                        checked={quiet.allowChannels.includes(c)}
                        disabled={c === "ntfy" && !person.ntfyTopic}
                        onChange={(e) => patchQuiet({ allowChannels: toggle(quiet.allowChannels, c, e.target.checked) })}
                      />
                      <span>{c}</span>
                    </label>
                  ))}
                </div>
                {quietError && <p role="alert" className="mn-error">{quietError}</p>}
              </>
            )}
          </fieldset>

          <div className="mn-row">
            <button type="button" className="mn-save" onClick={save} disabled={gridDisabled || Boolean(quietError)}>
              Save
            </button>
            {saved && <span role="status" className="mn-saved">Saved</span>}
            {saveError && <span role="alert" className="mn-error">{saveError}</span>}
          </div>
        </>
      )}
    </main>
  );
}
