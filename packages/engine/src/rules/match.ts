import { evaluate } from "@alerting/filter";
import type { Event } from "@alerting/shared";
import type { CompiledRule } from "./compile.js";
import { alertView } from "./event-view.js";

/** Every enabled rule whose `when` matches the event (all matches fire). */
export function matchRules(event: Event, rules: CompiledRule[]): CompiledRule[] {
  const ctx = { alert: alertView(event), event: event.parsed };
  return rules.filter((c) => {
    if (!c.rule.enabled) return false;
    try {
      return evaluate(c.when, ctx);
    } catch {
      return false;
    }
  });
}
