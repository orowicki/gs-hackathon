import { describe, expect, it } from "vitest";
import { nextEvent, oneOfEach, type DemoEvent } from "./events.ts";

function lcg(seed: number) {
  let s = seed;
  return () => (s = (s * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32;
}
const now = new Date("2026-10-23T09:14:02.331Z");

describe("demo events", () => {
  it("oneOfEach yields the three Appendix A shapes as JSON", () => {
    const evs = oneOfEach(lcg(1), now).map((e) => JSON.parse(e.line));
    expect(evs.some((e) => e.type === "WORKFLOW_FAILED")).toBe(true);
    expect(evs.some((e) => e.meta?.schema === "trade.rejected.v2")).toBe(true);
    expect(evs.filter((e) => e.alertname && e.labels.service && e.startsAt).length).toBe(2);
  });

  it("is deterministic for a seed and mixes all kinds, including junk and resolved", () => {
    const gen = (seed: number) => {
      const rng = lcg(seed);
      const recent: DemoEvent[] = [];
      const out: DemoEvent[] = [];
      for (let i = 0; i < 400; i++) {
        const e = nextEvent(rng, now, recent);
        recent.push(e);
        out.push(e);
      }
      return out;
    };
    expect(gen(7)).toEqual(gen(7));
    const kinds = new Set(gen(7).map((e) => e.kind));
    for (const k of ["workflow", "latency", "payments", "trade", "resolved", "junk"]) expect(kinds.has(k as never)).toBe(true);
    for (const e of gen(7)) if (e.kind !== "junk") expect(() => JSON.parse(e.line)).not.toThrow();
    for (const e of gen(7)) if (e.kind === "junk") expect(() => JSON.parse(e.line)).toThrow();
  });
});
