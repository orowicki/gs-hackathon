import { describe, expect, it } from "vitest";
import type { Rule } from "../../../../shared/src/types/rule";
import { gridFromPreference, preferenceFromForm, type QuietForm } from "./grid";
import { effectiveNow, quietActiveAt, quietSegments, rulesReaching } from "./insights";

const quiet = (from: string, to: string, allow = ["ui"]): QuietForm => ({ enabled: true, from, to, timezone: "UTC", allowChannels: allow });
const at = (hhmm: string) => new Date(`2026-11-21T${hhmm}:00Z`);

describe("quiet hours", () => {
  it("handles windows that wrap midnight", () => {
    const q = quiet("22:00", "07:00");
    expect(quietActiveAt(q, at("23:30"))).toBe(true);
    expect(quietActiveAt(q, at("06:59"))).toBe(true);
    expect(quietActiveAt(q, at("07:00"))).toBe(false);
    expect(quietActiveAt(q, at("12:00"))).toBe(false);
    expect(quietActiveAt({ ...q, enabled: false }, at("23:30"))).toBe(false);
  });

  it("uses the window's timezone", () => {
    // 21:30 UTC is 22:30 in Warsaw (winter, UTC+1).
    expect(quietActiveAt({ ...quiet("22:00", "07:00"), timezone: "Europe/Warsaw" }, at("21:30"))).toBe(true);
    expect(quietActiveAt(quiet("22:00", "07:00"), at("21:30"))).toBe(false);
  });

  it("splits a wrapping window into two timeline segments", () => {
    expect(quietSegments({ from: "06:00", to: "12:00" })).toEqual([[0.25, 0.5]]);
    expect(quietSegments({ from: "18:00", to: "06:00" })).toEqual([
      [0.75, 1],
      [0, 0.25],
    ]);
    expect(quietSegments({ from: "bad", to: "06:00" })).toEqual([]);
  });

  it("holds back channels that are not allowed while quiet", () => {
    const grid = { critical: ["ui", "ntfy", "email"], error: ["ui"], warning: [], info: [] };
    const quietNow = effectiveNow(grid, quiet("22:00", "07:00", ["ui", "ntfy"]), at("23:00"));
    expect(quietNow.critical).toEqual({ channels: ["ui", "ntfy"], held: ["email"] });
    expect(quietNow.warning).toEqual({ channels: [], held: [] });
    expect(effectiveNow(grid, quiet("22:00", "07:00"), at("12:00")).critical.held).toEqual([]);
  });
});

describe("grid with the live channel list", () => {
  it("keeps email in the grid when it is a registered channel", () => {
    const channels = ["ui", "ntfy", "email"];
    const grid = { critical: ["ui", "email"], error: [], warning: [], info: [] };
    const pref = preferenceFromForm("p1", grid, { ...quiet("22:00", "07:00", ["email"]) }, [], channels);
    expect(pref.rules[0]!.channels).toEqual(["ui", "email"]);
    expect(pref.quietHours?.allowChannels).toEqual(["email"]);
    expect(gridFromPreference(pref, channels).lossy).toBe(false);
    // Without email in the list the row can't be shown and is kept as an extra rule.
    expect(gridFromPreference(pref).lossy).toBe(true);
  });
});

describe("rulesReaching", () => {
  const rule = (id: string, who: Rule["who"], enabled = true) =>
    ({ id, name: id, enabled, when: "", who, looks: { titleTemplate: "", fields: [] }, createdAt: "", updatedAt: "" }) as Rule;
  const groups = [
    { id: "pricing-team", name: "Pricing team", memberIds: ["anna", "marek"] },
    { id: "rates-desk", name: "Rates desk", memberIds: ["ewa"] },
  ];

  it("finds direct and group recipients, with forced channels", () => {
    const rules = [
      rule("anna-personal", [{ recipients: [{ type: "person", id: "anna" }], force: ["ntfy"] }]),
      rule("pricing", [{ recipients: [{ type: "group", id: "pricing-team" }] }]),
      rule("rates", [{ recipients: [{ type: "group", id: "rates-desk" }] }]),
      rule("old", [{ recipients: [{ type: "person", id: "anna" }] }], false),
    ];
    const r = rulesReaching(rules, groups, "anna");
    expect(r.map((x) => x.rule.id)).toEqual(["anna-personal", "pricing", "old"]);
    expect(r[0]).toMatchObject({ via: ["you"], forced: ["ntfy"] });
    expect(r[1]).toMatchObject({ via: ["Pricing team"], forced: [] });
  });

  it("only counts forced channels from rows that reach the person", () => {
    const rules = [
      rule("mixed", [
        { recipients: [{ type: "group", id: "rates-desk" }], force: ["email"] },
        { recipients: [{ type: "group", id: "pricing-team" }] },
      ]),
    ];
    expect(rulesReaching(rules, groups, "anna")[0]!.forced).toEqual([]);
    expect(rulesReaching(rules, groups, "ewa")[0]!.forced).toEqual(["email"]);
  });
});
