import { evaluate } from "@alerting/filter";
import type { Event } from "@alerting/shared";
import { firstTime } from "../ids.js";
import type { CompiledRule, Logger } from "./compile.js";
import { alertView } from "./event-view.js";

/** Every enabled rule whose `when` matches the event (all matches fire). */
export function matchRules(event: Event, rules: CompiledRule[], logger: Logger = console): CompiledRule[] {
  const ctx = { alert: alertView(event), event: event.parsed };
  return rules.filter((c) => {
    if (!c.rule.enabled) return false;
    try {
      return evaluate(c.when, ctx);
    } catch (err) {
      // once per rule version, not per event
      if (firstTime(`match\u0000${c.rule.id}\u0000${c.rule.updatedAt}`)) {
        logger.error(`rule ${c.rule.id}: filter evaluation failed, treated as no match: ${(err as Error).message}`);
      }
      return false;
    }
  });
}
