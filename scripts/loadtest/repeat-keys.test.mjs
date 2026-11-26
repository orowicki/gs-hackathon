import { describe, expect, it } from "vitest";
import { buildRepeatBatch, entities, repeatDedupKey, repeatKeysOk } from "./run.mjs";

describe("repeat-keys probes use their own dedup key", () => {
  it("probe and measured events carry different keys, mapped by the schema template", () => {
    const probe = buildRepeatBatch("abc", -1, 1, 1, "probe");
    const measured = buildRepeatBatch("abc", 0, 2, 1);
    expect(probe[0].rkey).toBe("probe");
    expect(measured.every((e) => e.rkey === "events")).toBe(true);
    const tpl = entities("abc").schema.mapping.dedupKey;
    expect(tpl.kind).toBe("template");
    expect(tpl.template.replace("{{rkey}}", "events")).toBe(repeatDedupKey("abc", "events"));
    expect(repeatDedupKey("abc", "probe")).not.toBe(repeatDedupKey("abc", "events"));
  });

  it("ok only when the measured key has one alert counting exactly the events", () => {
    expect(repeatKeysOk({ events: 500, accepted: 500, alerts: 1, count: 500 })).toBe(true);
    expect(repeatKeysOk({ events: 500, accepted: 500, alerts: 1, count: 501 })).toBe(false);
    expect(repeatKeysOk({ events: 500, accepted: 500, alerts: 2, count: 500 })).toBe(false);
    expect(repeatKeysOk({ events: 500, accepted: 499, alerts: 1, count: 499 })).toBe(false);
  });
});
