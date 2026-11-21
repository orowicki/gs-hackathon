/*
 * Routing rules
 *
 * Rows (rule.who), evaluated in order:
 *  - A row with a condition applies when the condition matches the alert.
 *  - A row without a condition is "everyone else": it applies only if no earlier conditioned
 *    row applied.
 *  - A person gets one notification per channel, however many rows/groups reach them.
 *  - The first row that reaches a person decides how they are notified: a normal row uses their
 *    preferences; a `force` row uses exactly its channels. A later normal row never adds channels.
 *  - A later applying `force` row still reaches a person already reached: its channels are added
 *    (union) to what they already get. Force bypasses preferences and quiet hours.
 *  - `ntfy` is never produced for a person without an ntfyTopic, forced or not.
 *
 * Channel precedence for a normal row (first match wins):
 *  1. the first matching rule of the person's own preference;
 *  2. else the first matching rule of the preference of the group(s) the person was reached
 *     through, in row/recipient order;
 *  3. else the defaults (ui always; ntfy for error/critical when the person has an ntfyTopic).
 * Quiet hours: the person's own quietHours if set, else those of the first reaching group that
 * has them. Invalid quiet hours fail open (ignored) and are logged once.
 */
import { evaluate, parse, validateTree } from "@alerting/filter";
import type { FilterNode } from "@alerting/filter";
import type {
  Alert,
  ChannelId,
  Event,
  Notification,
  Person,
  Preference,
  Severity,
} from "@alerting/shared";
import { deterministicId, firstTime } from "../ids.js";
import type { CompiledRule, Logger } from "../rules/compile.js";
import { alertView } from "../rules/event-view.js";
import { renderLooks } from "../rules/looks.js";
import type { Directory } from "./directory.js";
import { inQuietHours } from "./quiet-hours.js";

export interface RouteInput {
  alert: Alert;
  event: Event;
  rule: CompiledRule;
  directory: Directory;
  now: Date;
  logger?: Logger;
  publicUrl?: string;
}

/** Lifecycle status of an alert (field is `status` in newer shared types, `state` in older). */
function alertStatus(alert: Alert): string {
  const a = alert as unknown as { status?: string; state?: string };
  return a.status ?? a.state ?? "open";
}

function matches(node: FilterNode | null, ctx: Record<string, unknown>, logger: Logger): boolean {
  try {
    return evaluate(node, ctx);
  } catch (err) {
    logger.error(`filter evaluation failed: ${(err as Error).message}`);
    return false;
  }
}

export function defaultChannels(person: Person, severity: Severity): ChannelId[] {
  const ch: ChannelId[] = ["ui"];
  if ((severity === "error" || severity === "critical") && person.ntfyTopic) ch.push("ntfy");
  return ch;
}

type CompiledPrefFilter = { node: FilterNode | null } | { error: string };
const prefFilterCache = new Map<string, CompiledPrefFilter>();

function compilePrefFilter(pref: Preference, when: unknown, logger: Logger): CompiledPrefFilter {
  const key = `${pref.ownerType}:${pref.ownerId}\u0000${JSON.stringify(when ?? null)}`;
  let c = prefFilterCache.get(key);
  if (!c) {
    try {
      c = { node: compileFilter(when) };
    } catch (err) {
      c = { error: (err as Error).message };
      logger.error(`preference ${pref.ownerType}:${pref.ownerId}: invalid filter, rule skipped: ${c.error}`);
    }
    if (prefFilterCache.size > 5000) prefFilterCache.clear();
    prefFilterCache.set(key, c);
  }
  return c;
}

function prefChannels(pref: Preference, ctx: Record<string, unknown>, logger: Logger): ChannelId[] | undefined {
  for (const r of pref.rules) {
    const c = compilePrefFilter(pref, r.when, logger);
    // an invalid filter must not behave like "match everything"
    if ("error" in c) continue;
    if (matches(c.node, ctx, logger)) return r.channels;
  }
  return undefined;
}

function compileFilter(f: unknown): FilterNode | null {
  if (f === undefined || f === null) return null;
  if (typeof f === "string") return parse(f);
  return validateTree(f);
}

interface Reach {
  person: Person;
  /** Groups the person was reached through by non-force rows, in row/recipient order. */
  groups: string[];
  /** The first row that reached the person was a normal (non-force) row. */
  normal: boolean;
  forced: Set<ChannelId>;
}

export function routeAlert(input: RouteInput): Notification[] {
  const { alert, event, rule, directory, now } = input;
  const logger = input.logger ?? console;
  const looks = renderLooks(rule.rule, event);
  const severity = alert.severity;
  const ctx = {
    alert: { ...alertView(event), severity, status: alertStatus(alert), state: alertStatus(alert) },
    event: event.parsed,
  };
  const publicUrl = input.publicUrl ?? process.env.PUBLIC_URL ?? "";
  const runbookUrl = (event.common as Record<string, unknown>).runbookUrl;
  const createdAt = now.toISOString();

  const out: Notification[] = [];
  const reaches = new Map<string, Reach>();
  let conditionApplied = false;

  for (const [i, row] of rule.rule.who.entries()) {
    const cond = rule.who[i]?.condition ?? null;
    const hasCondition = row.condition !== undefined && row.condition !== null;
    if (hasCondition) {
      if (!matches(cond, ctx, logger)) continue;
      conditionApplied = true;
    } else if (conditionApplied) continue;

    // person -> group they were reached through (undefined when listed directly)
    const reached: Array<{ person: Person; viaGroup?: string }> = [];
    for (const ref of row.recipients) {
      if (ref.type === "person") {
        const p = directory.person(ref.id);
        if (p) reached.push({ person: p });
        else logger.error(`rule ${rule.rule.id}: unknown person ${ref.id}, skipped`);
      } else {
        const g = directory.group(ref.id);
        if (!g) {
          logger.error(`rule ${rule.rule.id}: unknown group ${ref.id}, skipped`);
          continue;
        }
        for (const mid of g.memberIds) {
          const p = directory.person(mid);
          if (p) reached.push({ person: p, viaGroup: g.id });
          else logger.error(`group ${g.id}: unknown member ${mid}, skipped`);
        }
      }
    }

    for (const { person, viaGroup } of reached) {
      let r = reaches.get(person.id);
      if (!r) {
        r = { person, groups: [], normal: !row.force, forced: new Set() };
        reaches.set(person.id, r);
      }
      if (row.force) for (const c of row.force) r.forced.add(c);
      else if (r.normal && viaGroup && !r.groups.includes(viaGroup)) r.groups.push(viaGroup);
    }
  }

  for (const r of reaches.values()) {
    const { person } = r;
    const channels = new Set<ChannelId>();
    if (r.normal) {
      const personPref = directory.preference("person", person.id);
      const groupPrefs = r.groups.flatMap((g) => directory.preference("group", g) ?? []);
      let chosen = personPref ? prefChannels(personPref, ctx, logger) : undefined;
      for (const gp of groupPrefs) {
        if (chosen) break;
        chosen = prefChannels(gp, ctx, logger);
      }
      let base = chosen ?? defaultChannels(person, severity);
      const q = personPref?.quietHours ?? groupPrefs.find((p) => p.quietHours)?.quietHours;
      if (q) {
        try {
          if (inQuietHours(q, now)) {
            const allow = q.allowChannels ?? ["ui"];
            base = base.filter((c) => allow.includes(c));
          }
        } catch (err) {
          const owner = personPref?.quietHours ? personPref : groupPrefs.find((p) => p.quietHours);
          if (firstTime(`quiet\u0000${owner?.ownerType}:${owner?.ownerId}\u0000${JSON.stringify(q)}`)) {
            logger.error(`quiet hours ignored for ${owner?.ownerType}:${owner?.ownerId}: ${(err as Error).message}`);
          }
        }
      }
      for (const c of base) channels.add(c);
    }
    // force bypasses preferences and quiet hours; unioned with whatever the person already gets
    for (const c of r.forced) channels.add(c);

    for (const channel of channels) {
      if (channel === "ntfy" && !person.ntfyTopic) {
        if (firstTime(`ntfy\u0000${person.id}`)) {
          logger.error(`person ${person.id} has no ntfyTopic: ntfy notifications are skipped`);
        }
        continue;
      }
      const n: Notification = {
        id: deterministicId("notification", alert.id, person.id, channel),
        alertId: alert.id,
        recipientId: person.id,
        channel,
        severity,
        title: looks.title,
        clickUrl: `${publicUrl}/alerts/${alert.id}`,
        attempt: 0,
        createdAt,
      };
      if (looks.body !== undefined) n.body = looks.body;
      if (typeof runbookUrl === "string" && runbookUrl) n.runbookUrl = runbookUrl;
      out.push(n);
    }
  }
  return out;
}
