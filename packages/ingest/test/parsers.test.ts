import { describe, expect, it } from "vitest";
import {
  PARSERS,
  parse,
  registerParser,
  listSourcePlugins,
  registerSourcePlugin,
  getSourcePlugin,
  FILE_TAIL_CONFIG_SCHEMA,
} from "../src/index.js";

const c = (type: "json" | "logfmt" | "regex" | "raw", pattern?: string) => ({
  type,
  pattern,
});

describe("json", () => {
  it("parses objects", () =>
    expect(parse('{"a":1,"b":{"c":"x"}}', c("json"))).toEqual({
      a: 1,
      b: { c: "x" },
    }));
  it("returns object input as-is", () =>
    expect(parse({ a: 1 }, c("json"))).toEqual({ a: 1 }));
  it("falls back on invalid json", () =>
    expect(parse("{nope", c("json"))).toEqual({ raw: "{nope" }));
  it("falls back on arrays and scalars", () => {
    expect(parse("[1,2]", c("json"))).toEqual({ raw: "[1,2]" });
    expect(parse("42", c("json"))).toEqual({ raw: "42" });
    expect(parse("null", c("json"))).toEqual({ raw: "null" });
  });
});

describe("logfmt", () => {
  it("parses pairs, quotes, escapes and bare keys", () => {
    expect(
      parse(
        'level=error msg="a b" q="say \\"hi\\"" n=5 flag empty=',
        c("logfmt"),
      ),
    ).toEqual({
      level: "error",
      msg: "a b",
      q: 'say "hi"',
      n: "5",
      flag: true,
      empty: "",
    });
  });
  it("falls back when nothing found", () =>
    expect(parse("   ", c("logfmt"))).toEqual({ raw: "   " }));
  it("stringifies object input", () =>
    expect(parse({ a: "b" }, c("logfmt")).raw).toBeUndefined());
});

describe("regex", () => {
  const p = "^(?<ip>\\S+) (?<code>\\d{3})(?: (?<extra>x))?$";
  it("extracts named groups, omitting undefined", () =>
    expect(parse("1.2.3.4 200", c("regex", p))).toEqual({
      ip: "1.2.3.4",
      code: "200",
    }));
  it("falls back on no match", () =>
    expect(parse("zzz", c("regex", p))).toEqual({ raw: "zzz" }));
  it("falls back on bad pattern", () =>
    expect(parse("zzz", c("regex", "(?<a"))).toEqual({ raw: "zzz" }));
  it("falls back without pattern", () =>
    expect(parse("zzz", c("regex"))).toEqual({ raw: "zzz" }));
  it("falls back when pattern has no named groups", () =>
    expect(parse("zzz", c("regex", "z+"))).toEqual({ raw: "zzz" }));
});

describe("raw and dispatcher", () => {
  it("raw keeps text", () =>
    expect(parse("hello", c("raw"))).toEqual({ raw: "hello" }));
  it("raw stringifies objects", () =>
    expect(parse({ a: 1 }, c("raw"))).toEqual({ raw: '{"a":1}' }));
  it("strips trailing CRLF", () => {
    expect(parse("hello\r\n", c("raw"))).toEqual({ raw: "hello" });
    expect(parse('{"a":1}\r\n', c("json"))).toEqual({ a: 1 });
    expect(parse("a=b\n", c("logfmt"))).toEqual({ a: "b" });
  });
  it("registry covers all types and is pluggable", () => {
    expect(Object.keys(PARSERS)).toEqual(
      expect.arrayContaining(["json", "logfmt", "regex", "raw"]),
    );
    registerParser("custom", () => ({ ok: true }));
    expect(parse("x", { type: "custom" as never })).toEqual({ ok: true });
  });
  it("unknown type and throwing parser fall back", () => {
    expect(parse("x", { type: "nope" as never })).toEqual({ raw: "x" });
    registerParser("boom", () => {
      throw new Error("x");
    });
    expect(parse("y", { type: "boom" as never })).toEqual({ raw: "y" });
  });
});

describe("plugin registry", () => {
  it("registers and lists", () => {
    registerSourcePlugin({
      type: "t",
      configSchema: FILE_TAIL_CONFIG_SCHEMA,
      start: async () => ({ stop: async () => {} }),
    });
    expect(getSourcePlugin("t")?.type).toBe("t");
    expect(listSourcePlugins().map((p) => p.type)).toContain("t");
  });
});
