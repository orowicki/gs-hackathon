import type { ChannelId, Severity } from "../../../../shared/src/types/common";
import type { Group } from "../../../../shared/src/types/people";
import type { Rule } from "../../../../shared/src/types/rule";
import { SEVERITY_ROWS, isValidTime, isValidTimezone, type Grid, type QuietForm } from "./grid";

const minutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return h! * 60 + m!;
};

/** Minutes since midnight at `at` in `timezone`. */
export function localMinutes(at: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(at);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

/** Whether quiet hours are on at `at`. Windows may wrap midnight (22:00 to 07:00). */
export function quietActiveAt(q: QuietForm, at: Date): boolean {
  if (!q.enabled || !isValidTime(q.from) || !isValidTime(q.to) || !isValidTimezone(q.timezone.trim())) return false;
  const now = localMinutes(at, q.timezone.trim());
  const from = minutes(q.from);
  const to = minutes(q.to);
  return from < to ? now >= from && now < to : now >= from || now < to;
}

/** The quiet window as [start, end) fractions of a day, split in two when it wraps midnight. */
export function quietSegments(q: Pick<QuietForm, "from" | "to">): Array<[number, number]> {
  if (!isValidTime(q.from) || !isValidTime(q.to)) return [];
  const a = minutes(q.from) / 1440;
  const b = minutes(q.to) / 1440;
  if (a === b) return [];
  return a < b ? [[a, b]] : [[a, 1], [0, b]];
}

/** Channels each severity reaches right now: the grid, cut down to the allowed channels during quiet hours. */
export function effectiveNow(grid: Grid, quiet: QuietForm, at: Date): Record<Severity, { channels: ChannelId[]; held: ChannelId[] }> {
  const active = quietActiveAt(quiet, at);
  const out = {} as Record<Severity, { channels: ChannelId[]; held: ChannelId[] }>;
  for (const sev of SEVERITY_ROWS) {
    const all = grid[sev];
    const channels = active ? all.filter((c) => quiet.allowChannels.includes(c)) : [...all];
    out[sev] = { channels, held: all.filter((c) => !channels.includes(c)) };
  }
  return out;
}

export interface RuleReach {
  rule: Rule;
  /** "you" for a direct recipient, otherwise the group names that include the person. */
  via: string[];
  /** Channels a row forces for this person, overriding their preferences. */
  forced: ChannelId[];
}

/** Rules whose `who` rows name the person directly or through a group, with how they are reached. */
export function rulesReaching(rules: Rule[], groups: Group[], personId: string): RuleReach[] {
  const groupsOf = new Map(groups.map((g) => [g.id, g]));
  const out: RuleReach[] = [];
  for (const rule of rules) {
    const via = new Set<string>();
    const forced = new Set<ChannelId>();
    for (const row of rule.who ?? []) {
      let hit = false;
      for (const r of row.recipients ?? []) {
        if (r.type === "person" && r.id === personId) {
          via.add("you");
          hit = true;
        } else if (r.type === "group") {
          const g = groupsOf.get(r.id);
          if (g?.memberIds.includes(personId)) {
            via.add(g.name || g.id);
            hit = true;
          }
        }
      }
      if (hit) for (const c of row.force ?? []) forced.add(c);
    }
    if (via.size > 0) out.push({ rule, via: [...via], forced: [...forced] });
  }
  return out.sort((a, b) => Number(b.rule.enabled) - Number(a.rule.enabled) || a.rule.name.localeCompare(b.rule.name));
}

/** IANA timezones for the picker (falls back to a short list on older browsers). */
export function timezones(current: string): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
  let list: string[] = [];
  try {
    list = intl.supportedValuesOf?.("timeZone") ?? [];
  } catch {
    list = [];
  }
  if (list.length === 0) list = ["UTC", "Europe/London", "Europe/Warsaw", "Europe/Berlin", "America/New_York", "Asia/Singapore", "Asia/Tokyo"];
  return list.includes(current) ? list : [current, ...list];
}
