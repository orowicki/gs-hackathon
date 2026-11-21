import type { ConfigStore } from "@alerting/config";
import type { Rule } from "@alerting/shared";
import { tryCompileRule, type CompiledRule, type Logger } from "./compile.js";

export interface RuleCache {
  ready: Promise<void>;
  rules(): CompiledRule[];
  close(): void;
}

export function createStaticRuleCache(rules: Rule[], logger?: Logger): RuleCache {
  const compiled = rules.flatMap((r) => tryCompileRule(r, logger) ?? []);
  return { ready: Promise.resolve(), rules: () => compiled, close() {} };
}

export function createRuleCache(store: ConfigStore, opts: { logger?: Logger } = {}): RuleCache {
  const logger = opts.logger ?? console;
  const map = new Map<string, CompiledRule>();
  let closed = false;
  let unsub: (() => void) | undefined;

  const apply = (id: string, rule: Rule | undefined) => {
    const c = rule ? tryCompileRule(rule, logger) : undefined;
    if (c) map.set(id, c);
    else map.delete(id);
  };

  const ready = (async () => {
    // Subscribe first so changes during the initial load are not lost.
    const u = await store.onChange("rule", async (change) => {
      if (closed) return;
      try {
        if (change.op === "delete") map.delete(change.id);
        else apply(change.id, await store.get("rule", change.id));
      } catch (err) {
        logger.error(`rule cache: failed to apply change for ${change.id}: ${(err as Error).message}`);
      }
    });
    if (closed) u();
    else unsub = u;
    const all = await store.list("rule");
    for (const r of all) if (!map.has(r.id)) apply(r.id, r);
  })();

  return {
    ready,
    rules: () => [...map.values()].filter((c) => c.rule.enabled),
    close() {
      closed = true;
      unsub?.();
    },
  };
}
