import type { ChannelId, Severity } from "../../../../shared/src/types/common";
import type { Filter } from "../../../../shared/src/types/filter";
import type { Person, Preference, PreferenceRule, QuietHours } from "../../../../shared/src/types/people";

export const SEVERITY_ROWS: Severity[] = ["critical", "error", "warning", "info"];
export const CHANNELS: ChannelId[] = ["ui", "ntfy"];

export type Grid = Record<Severity, ChannelId[]>;

export interface QuietForm {
  enabled: boolean;
  from: string;
  to: string;
  timezone: string;
  allowChannels: ChannelId[];
}

export function emptyGrid(): Grid {
  return { critical: [], error: [], warning: [], info: [] };
}

/** Defaults when no preference exists: ui always, ntfy for error/critical if the person has a topic. */
export function defaultGrid(person?: Pick<Person, "ntfyTopic">): Grid {
  const ntfy = Boolean(person?.ntfyTopic);
  return {
    critical: ntfy ? ["ui", "ntfy"] : ["ui"],
    error: ntfy ? ["ui", "ntfy"] : ["ui"],
    warning: ["ui"],
    info: ["ui"],
  };
}

export function defaultQuiet(timezone: string): QuietForm {
  return { enabled: false, from: "22:00", to: "07:00", timezone, allowChannels: ["ui"] };
}

export function severityFilter(sev: Severity): Filter {
  return { type: "cmp", field: "alert.severity", op: "=", value: sev };
}

/** The severity if the filter is exactly `alert.severity = <sev>` (tree or text form). */
export function severityOfFilter(f: Filter): Severity | undefined {
  if (typeof f === "string") {
    const m = /^\s*alert\.severity\s*=\s*"?([a-z]+)"?\s*$/.exec(f);
    return m && (SEVERITY_ROWS as string[]).includes(m[1]!) ? (m[1] as Severity) : undefined;
  }
  if (f.type === "cmp" && f.field === "alert.severity" && f.op === "=" && typeof f.value === "string") {
    return (SEVERITY_ROWS as string[]).includes(f.value) ? (f.value as Severity) : undefined;
  }
  return undefined;
}

export function isValidTime(s: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

export function gridFromPreference(pref: Pick<Preference, "rules">): {
  grid: Grid;
  lossy: boolean;
  extraRules: PreferenceRule[];
} {
  const grid = emptyGrid();
  const seen = new Set<Severity>();
  const extraRules: PreferenceRule[] = [];
  for (const rule of pref.rules ?? []) {
    const sev = severityOfFilter(rule.when);
    const known = Array.isArray(rule.channels) && rule.channels.every((c) => CHANNELS.includes(c));
    if (!sev || seen.has(sev) || !known) {
      extraRules.push(rule); // kept unchanged after the grid rules
      continue;
    }
    seen.add(sev);
    grid[sev] = [...rule.channels];
  }
  return { grid, lossy: extraRules.length > 0, extraRules };
}

export function quietFromPreference(pref: Preference, timezone: string): QuietForm {
  const q = pref.quietHours;
  if (!q) return defaultQuiet(timezone);
  return {
    enabled: true,
    from: q.from,
    to: q.to,
    timezone: q.timezone,
    allowChannels: q.allowChannels ?? ["ui"],
  };
}

/** Build the preference. Every severity row yields a rule (empty channels = none). */
export function preferenceFromForm(personId: string, grid: Grid, quiet: QuietForm, extraRules: PreferenceRule[] = []): Preference {
  const rules: PreferenceRule[] = SEVERITY_ROWS.map((sev) => ({
    when: severityFilter(sev),
    channels: CHANNELS.filter((c) => grid[sev].includes(c)),
  }));
  const pref: Preference = { ownerType: "person", ownerId: personId, rules: [...rules, ...extraRules] };
  if (quiet.enabled) {
    const qh: QuietHours = {
      from: quiet.from,
      to: quiet.to,
      timezone: quiet.timezone,
      allowChannels: CHANNELS.filter((c) => quiet.allowChannels.includes(c)),
    };
    pref.quietHours = qh;
  }
  return pref;
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function validateQuiet(q: QuietForm): string | undefined {
  if (!q.enabled) return undefined;
  if (!isValidTime(q.from)) return "From must be a time as HH:MM (00:00 to 23:59).";
  if (!isValidTime(q.to)) return "To must be a time as HH:MM (00:00 to 23:59).";
  if (!q.timezone.trim()) return "Timezone is required.";
  if (!isValidTimezone(q.timezone.trim())) return "Timezone is not a valid IANA timezone.";
  if (q.from === q.to) return "From and To must be different.";
  return undefined;
}

/** Selected person id from the stored value: a raw id or a JSON string. */
export function parseStoredProfile(raw: string | null): string | undefined {
  if (!raw) return undefined;
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v === "string") return v || undefined;
    if (typeof v === "number") return String(v);
    if (v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string") return (v as { id: string }).id;
  } catch {
    /* raw id */
  }
  return raw;
}
