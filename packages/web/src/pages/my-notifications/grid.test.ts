import { describe, expect, it } from "vitest";
import type { Preference } from "../../../../shared/src/types/people";
import {
  defaultGrid,
  gridFromPreference,
  isValidTime,
  parseStoredProfile,
  preferenceFromForm,
  quietFromPreference,
  severityFilter,
  validateQuiet,
} from "./grid";

describe("grid <-> preference", () => {
  it("round-trips, including empty rows", () => {
    const grid = { critical: ["ui", "ntfy"], error: ["ui"], warning: [], info: [] };
    const quiet = { enabled: true, from: "22:00", to: "07:00", timezone: "Europe/Berlin", allowChannels: ["ui"] };
    const pref = preferenceFromForm("p1", grid, quiet);
    expect(pref.ownerType).toBe("person");
    expect(pref.rules).toHaveLength(4);
    expect(pref.rules[0]).toEqual({ when: severityFilter("critical"), channels: ["ui", "ntfy"] });
    expect(pref.rules[2]!.channels).toEqual([]);
    expect(gridFromPreference(pref)).toEqual({ grid, lossy: false });
    expect(quietFromPreference(pref, "UTC")).toEqual(quiet);
  });

  it("omits quietHours when disabled", () => {
    const pref = preferenceFromForm("p1", defaultGrid(), { enabled: false, from: "", to: "", timezone: "UTC", allowChannels: [] });
    expect(pref.quietHours).toBeUndefined();
    expect(quietFromPreference(pref, "UTC").enabled).toBe(false);
  });

  it("flags rules it cannot express", () => {
    const pref: Preference = {
      ownerType: "person",
      ownerId: "p1",
      rules: [
        { when: { type: "cmp", field: "alert.source", op: "=", value: "x" }, channels: ["ui"] },
        { when: "alert.severity = error", channels: ["ntfy"] },
      ],
    };
    const r = gridFromPreference(pref);
    expect(r.lossy).toBe(true);
    expect(r.grid.error).toEqual(["ntfy"]);
  });

  it("defaults", () => {
    expect(defaultGrid({ ntfyTopic: "t" }).critical).toEqual(["ui", "ntfy"]);
    expect(defaultGrid({}).critical).toEqual(["ui"]);
    expect(defaultGrid({ ntfyTopic: "t" }).warning).toEqual(["ui"]);
  });

  it("validates HH:MM", () => {
    expect(isValidTime("07:30")).toBe(true);
    expect(isValidTime("24:00")).toBe(false);
    expect(isValidTime("7:30")).toBe(false);
    expect(validateQuiet({ enabled: true, from: "bad", to: "07:00", timezone: "UTC", allowChannels: [] })).toMatch(/From/);
    expect(validateQuiet({ enabled: false, from: "bad", to: "x", timezone: "", allowChannels: [] })).toBeUndefined();
  });

  it("parses stored profile", () => {
    expect(parseStoredProfile("abc")).toBe("abc");
    expect(parseStoredProfile('"abc"')).toBe("abc");
    expect(parseStoredProfile('{"id":"abc"}')).toBe("abc");
    expect(parseStoredProfile(null)).toBeUndefined();
  });
});
