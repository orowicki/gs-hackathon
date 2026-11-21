import { randomUUID } from "node:crypto";
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

const compiledPrefCache = new WeakMap<object, FilterNode | null>();

function prefChannels(pref: Preference, ctx: Record<string, unknown>, logger: Logger): ChannelId[] | undefined {
  for (const r of pref.rules) {
    let node = compiledPrefCache.get(r);
    if (node === undefined) {
      try {
        node = compileFilter(r.when);
      } catch (err) {
        logger.error(`preference ${pref.ownerType}:${pref.ownerId}: invalid filter: ${(err as Error).message}`);
        node = null;
        // an invalid filter must not behave like "match everything"
        continue;
      }
      compiledPrefCache.set(r, node);
    }
    if (matches(node, ctx, logger)) return r.channels;
  }
  return undefined;
}

function compileFilter(f: unknown): FilterNode | null {
  if (f === undefined || f === null) return null;
  if (typeof f === "string") return parse(f);
  return validateTree(f);
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
  const done = new Set<string>();
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
      if (done.has(person.id)) continue;
      done.add(person.id);

      let channels: ChannelId[];
      if (row.force) {
        channels = [...row.force];
      } else {
        const pref =
          directory.preference("person", person.id) ??
          (viaGroup ? directory.preference("group", viaGroup) : undefined);
        channels = (pref && prefChannels(pref, ctx, logger)) || defaultChannels(person, severity);
        const q = pref?.quietHours;
        if (q) {
          try {
            if (inQuietHours(q, now)) {
              const allow = q.allowChannels ?? ["ui"];
              channels = channels.filter((c) => allow.includes(c));
            }
          } catch (err) {
            logger.error(`quiet hours ignored for ${person.id}: ${(err as Error).message}`);
          }
        }
      }

      for (const channel of new Set(channels)) {
        const n: Notification = {
          id: randomUUID(),
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
  }
  return out;
}
