import { describe, expect, it } from "vitest";
import { isDataError, stripNul } from "../src/event-store.js";
import {
  buildEvent,
  decodeRawEntry,
  eventIdFor,
  toRawMessage,
} from "../src/index.js";

describe("decodeRawEntry", () => {
  it("decodes a valid entry", () => {
    const msg = toRawMessage("s1", "hello", "2026-01-01T00:00:00.000Z");
    expect(decodeRawEntry(["data", JSON.stringify(msg)])).toEqual(msg);
  });
  it("rejects malformed entries", () => {
    expect(decodeRawEntry([])).toBeUndefined();
    expect(decodeRawEntry(["data", "{nope"])).toBeUndefined();
    expect(
      decodeRawEntry(["data", JSON.stringify({ sourceId: 1, raw: "x" })]),
    ).toBeUndefined();
    expect(decodeRawEntry(["x", "data"])).toBeUndefined();
  });
  it("replaces a bad receivedAt", () => {
    const m = decodeRawEntry([
      "data",
      JSON.stringify({ sourceId: "s", raw: "x", receivedAt: "zzz" }),
    ]);
    expect(Number.isNaN(Date.parse(m!.receivedAt))).toBe(false);
  });
});

describe("toRawMessage", () => {
  it("serialises objects", () =>
    expect(toRawMessage("s", { a: 1 }).raw).toBe('{"a":1}'));
});

describe("buildEvent", () => {
  const msg = {
    sourceId: "s1",
    receivedAt: "2026-01-01T00:00:00.000Z",
    raw: '{"level":"error"}',
  };
  it("parses with the source parser", () => {
    const e = buildEvent("1-0", msg, { type: "json" });
    expect(e).toMatchObject({
      sourceId: "s1",
      receivedAt: msg.receivedAt,
      raw: msg.raw,
      parsed: { level: "error" },
      schemaId: null,
      common: {},
    });
    expect(e.id).toBe(eventIdFor("1-0"));
    expect(e.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(eventIdFor("1-1")).not.toBe(e.id);
  });
  it("falls back to {raw} for unparseable input", () => {
    expect(
      buildEvent("2-0", { ...msg, raw: "not json" }, { type: "json" }).parsed,
    ).toEqual({ raw: "not json" });
  });
});

describe("stripNul", () => {
  it("removes NUL from nested strings and keys", () => {
    expect(
      stripNul({ "a\u0000": ["x\u0000y", 1, null, { b: "\u0000" }] }),
    ).toEqual({ a: ["xy", 1, null, { b: "" }] });
    expect(stripNul("clean")).toBe("clean");
  });
});

describe("isDataError", () => {
  it("only pg class 22/23 are data errors", () => {
    expect(isDataError({ code: "22P05" })).toBe(true);
    expect(isDataError({ code: "23505" })).toBe(true);
    expect(isDataError({ code: "08006" })).toBe(false);
    expect(isDataError(new Error("ECONNRESET"))).toBe(false);
    expect(isDataError(null)).toBe(false);
  });
});
