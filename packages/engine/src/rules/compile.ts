import { parse, validateTree, type FilterNode } from "@alerting/filter";
import type { Filter, Rule } from "@alerting/shared";

export interface Logger {
  error(message: string, ...args: unknown[]): void;
}

export interface CompiledWho {
  condition: FilterNode | null;
  index: number;
}

export interface CompiledRule {
  rule: Rule;
  when: FilterNode | null;
  who: CompiledWho[];
}

function toTree(f: Filter | undefined | null): FilterNode | null {
  if (f === undefined || f === null) return null;
  if (typeof f === "string") return parse(f);
  return validateTree(f);
}

const cache = new Map<string, CompiledRule>();

/** Compile a rule once (cached by id + updatedAt). Throws on an invalid filter. */
export function compileRule(rule: Rule): CompiledRule {
  const key = `${rule.id}\u0000${rule.updatedAt}`;
  const hit = cache.get(key);
  if (hit && hit.rule === rule) return hit;
  const compiled: CompiledRule = {
    rule,
    when: toTree(rule.when),
    who: (rule.who ?? []).map((w, index) => ({ condition: toTree(w.condition), index })),
  };
  cache.set(key, compiled);
  if (cache.size > 5000) cache.delete(cache.keys().next().value as string);
  return compiled;
}

/** Like compileRule but logs and returns undefined for an invalid rule. */
export function tryCompileRule(rule: Rule, logger?: Logger): CompiledRule | undefined {
  try {
    return compileRule(rule);
  } catch (err) {
    (logger ?? console).error(`rule ${rule?.id}: invalid filter, rule skipped: ${(err as Error).message}`);
    return undefined;
  }
}
