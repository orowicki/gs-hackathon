import type { ConfigStore } from "@alerting/config";
import type { Rule } from "@alerting/shared";
import { trackConfig } from "../live.js";
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

  const tracker = trackConfig(store, "rule", {
    logger,
    label: "rule cache",
    idOf: (e) => (e as Rule).id,
    put(id, entity) {
      const c = entity ? tryCompileRule(entity as Rule, logger) : undefined;
      if (c) map.set(id, c);
      else map.delete(id);
    },
  });

  return {
    ready: tracker.ready,
    rules: () => [...map.values()].filter((c) => c.rule.enabled),
    close() {
      tracker.close();
    },
  };
}
