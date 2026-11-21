import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { tryParse } from "@alerting/filter";
import { renderTemplate, validateRunbook } from "../src/index.js";

const dir = new URL("../../../config/runbooks/", import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith(".yaml"));
const ruleIds = new Set(
  readdirSync(new URL("../../../config/rules/", import.meta.url))
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => String((parse(readFileSync(new URL(`../../../config/rules/${f}`, import.meta.url), "utf8")) as { id: string }).id)),
);

describe("config/runbooks", () => {
  it.each(files)("%s is a valid runbook with a parseable filter and runnable steps", (f) => {
    const raw = parse(readFileSync(new URL(f, dir), "utf8")) as Record<string, unknown>;
    const v = validateRunbook(raw);
    if (!v.ok) throw new Error(v.error);
    if (typeof raw.matches === "string") expect(tryParse(raw.matches).ok).toBe(true);
    for (const st of (raw.steps as { action: string }[] | undefined) ?? []) expect(["http", "escalate", "wait"]).toContain(st.action);
    // A rule's own runbook is named rule-<ruleId> so the alert page can edit it.
    if (raw.ruleId !== undefined) {
      expect(ruleIds.has(String(raw.ruleId))).toBe(true);
      expect(raw.id).toBe(`rule-${String(raw.ruleId)}`);
      expect(raw.matches).toBe(`alert.ruleId = "${String(raw.ruleId)}"`);
    }
  });

  it("every demo rule has its own runbook", () => {
    const own = new Set(files.map((f) => (parse(readFileSync(new URL(f, dir), "utf8")) as { ruleId?: string }).ruleId));
    expect([...ruleIds].filter((r) => !own.has(r))).toEqual([]);
  });

  it("text runbooks fill in the alert's values", () => {
    const raw = parse(readFileSync(new URL("rule-rates-trade-rejected.yaml", dir), "utf8")) as { content: string };
    const out = renderTemplate(raw.content, {
      event: { parsed: { payload: { tradeId: "T-1", desk: "rates", currency: "EUR", notional: 25000000, reason: "LIMIT_BREACH" } } } as never,
    });
    expect(out).toContain("Trade T-1 on the rates desk was rejected: EUR 25000000, reason LIMIT_BREACH.");
  });
});
