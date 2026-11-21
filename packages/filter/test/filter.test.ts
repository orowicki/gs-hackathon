import { describe, expect, it } from "vitest";
import {
  COMMON_FIELDS,
  KEYWORDS,
  OPERATORS,
  SEVERITY_ORDER,
  evaluate,
  parse,
  print,
  suggestContext,
  tryParse,
  validateTree,
  FilterSyntaxError,
  type FilterNode,
} from "../src/index.js";

function ev(text: string, ctx: { alert?: Record<string, unknown>; event?: unknown } = {}): boolean {
  return evaluate(parse(text), ctx);
}
const sev = (s: string) => ({ alert: { severity: s } });

describe("operators", () => {
  const event = { payload: { notional: 12000000, count: "7", name: "pricing-engine-eu", tags: ["a", "b"] }, error: { code: "timeout" } };
  it("= and !=", () => {
    expect(ev("error.code = timeout", { event })).toBe(true);
    expect(ev("error.code = other", { event })).toBe(false);
    expect(ev("error.code != other", { event })).toBe(true);
    expect(ev("error.code != timeout", { event })).toBe(false);
    expect(ev('payload.name = "pricing-engine-eu"', { event })).toBe(true);
    expect(ev("payload.count = 7", { event })).toBe(true);
    expect(ev('payload.count = "7"', { event })).toBe(true);
    expect(ev("payload.count = 7.0", { event })).toBe(true);
    expect(ev("payload.count != 7", { event })).toBe(false);
  });
  it("> >= < <=", () => {
    expect(ev("payload.notional > 10000000", { event })).toBe(true);
    expect(ev("payload.notional > 12000000", { event })).toBe(false);
    expect(ev("payload.notional >= 12000000", { event })).toBe(true);
    expect(ev("payload.notional < 12000001", { event })).toBe(true);
    expect(ev("payload.notional < 12000000", { event })).toBe(false);
    expect(ev("payload.notional <= 12000000", { event })).toBe(true);
    expect(ev("payload.count > 5", { event })).toBe(true);
    expect(ev("payload.count < 5", { event })).toBe(false);
    expect(ev("payload.notional > -1", { event })).toBe(true);
  });
  it("no string ordering", () => {
    expect(ev("error.code > a", { event })).toBe(false);
    expect(ev("error.code < z", { event })).toBe(false);
    expect(ev("error.code > 5", { event })).toBe(false);
  });
  it("contains", () => {
    expect(ev("payload.name contains engine", { event })).toBe(true);
    expect(ev("payload.name contains Engine", { event })).toBe(false);
    expect(ev("payload.tags contains a", { event })).toBe(true);
    expect(ev("payload.tags contains c", { event })).toBe(false);
    expect(ev("payload.tags contains eng", { event })).toBe(false);
  });
  it("in with mixed types", () => {
    expect(ev('error.code in [timeout, "bad thing", 3]', { event })).toBe(true);
    expect(ev("error.code in [a, b]", { event })).toBe(false);
    expect(ev("payload.count in [1, 7]", { event })).toBe(true);
    expect(ev('payload.count in ["x", 8]', { event })).toBe(false);
    expect(ev('error.code in ["bad thing", timeout]', { event })).toBe(true);
    expect(ev("error.code in []", { event })).toBe(false);
  });
  it("matches glob", () => {
    const e = (name: string) => ({ event: { name } });
    expect(ev("name matches pricing-engine-*", e("pricing-engine-eu"))).toBe(true);
    expect(ev("name matches pricing-engine-*", e("xpricing-engine-eu"))).toBe(false);
    expect(ev("name matches a?c", e("abc"))).toBe(true);
    expect(ev("name matches a?c", e("abbc"))).toBe(false);
    expect(ev("name matches a.c", e("a.c"))).toBe(true);
    expect(ev("name matches a.c", e("abc"))).toBe(false);
    expect(ev("name matches a+c", e("a+c"))).toBe(true);
    expect(ev("name matches a+c", e("aac"))).toBe(false);
    expect(ev("name matches abc", e("abcd"))).toBe(false);
    expect(ev("name matches *", e(""))).toBe(true);
    expect(ev('name matches "a (b) [c]"', e("a (b) [c]"))).toBe(true);
    expect(ev("name matches ABC", e("abc"))).toBe(false);
  });
});

describe("severity ordering", () => {
  it("exports the order", () => {
    expect(SEVERITY_ORDER).toEqual({ critical: 4, error: 3, warning: 2, info: 1 });
  });
  it(">= and >", () => {
    const r = (s: string, q: string) => ev(q, sev(s));
    expect(["critical", "error", "warning", "info"].map((s) => r(s, "alert.severity >= error"))).toEqual([true, true, false, false]);
    expect(["critical", "error", "warning", "info"].map((s) => r(s, "alert.severity > error"))).toEqual([true, false, false, false]);
  });
  it("<= and <", () => {
    const r = (s: string, q: string) => ev(q, sev(s));
    expect(["critical", "error", "warning", "info"].map((s) => r(s, "alert.severity <= warning"))).toEqual([false, false, true, true]);
    expect(["critical", "error", "warning", "info"].map((s) => r(s, "alert.severity < warning"))).toEqual([false, false, false, true]);
  });
  it("compares case-insensitively", () => {
    expect(ev("alert.severity >= WARNING", sev("error"))).toBe(true);
    expect(ev("alert.severity >= error", sev("CRITICAL"))).toBe(true);
    expect(ev("alert.severity < Error", sev("Warning"))).toBe(true);
    expect(ev("alert.severity = WARNING", sev("warning"))).toBe(false);
  });
  it("unknown values are false", () => {
    expect(ev("alert.severity >= error", sev("fatal"))).toBe(false);
    expect(ev("alert.severity >= bogus", sev("critical"))).toBe(false);
    expect(ev("alert.severity < bogus", sev("critical"))).toBe(false);
  });
  it("equality still plain", () => {
    expect(ev("alert.severity = critical", sev("critical"))).toBe(true);
    expect(ev("alert.severity != critical", sev("error"))).toBe(true);
  });
});

describe("fields", () => {
  it("case-sensitive names", () => {
    expect(ev("alert.Severity = critical", sev("critical"))).toBe(false);
    expect(ev("alert.severity = critical", sev("critical"))).toBe(true);
    expect(ev("Error.code = x", { event: { error: { code: "x" } } })).toBe(false);
  });
  it("alert.* reads alert, others read event", () => {
    const ctx = { alert: { title: "A" }, event: { title: "E", alert: { title: "nested" } } };
    expect(ev("alert.title = A", ctx)).toBe(true);
    expect(ev("title = E", ctx)).toBe(true);
  });
  it("missing fields", () => {
    expect(ev("x.y = 1")).toBe(false);
    expect(ev("x.y != 1")).toBe(true);
    expect(ev("x.y > 1", { event: {} })).toBe(false);
    expect(ev("x.y < 1", { event: {} })).toBe(false);
    expect(ev("x.y contains a", { event: {} })).toBe(false);
    expect(ev("x.y in [a]", { event: {} })).toBe(false);
    expect(ev("x.y matches *", { event: {} })).toBe(false);
    expect(ev("x.y = a", { event: { x: { y: null } } })).toBe(false);
    expect(ev("x.y != a", { event: { x: { y: null } } })).toBe(true);
    expect(ev("alert.severity >= info", {})).toBe(false);
  });
  it("does not read prototype properties", () => {
    expect(ev("constructor = x", { event: {} })).toBe(false);
    expect(ev("a.__proto__ = x", { event: { a: {} } })).toBe(false);
  });
  it("hyphens and underscores in names", () => {
    expect(ev("a_b.c-d = 1", { event: { a_b: { "c-d": 1 } } })).toBe(true);
  });
});

describe("precedence and keywords", () => {
  const T = { event: { a: 1, b: 1, c: 1 } };
  const F = { event: { a: 0, b: 0, c: 0 } };
  it("a OR b AND c", () => {
    expect(parse("a = 1 OR b = 1 AND c = 1")).toEqual({
      type: "or",
      children: [
        { type: "cmp", field: "a", op: "=", value: 1 },
        {
          type: "and",
          children: [
            { type: "cmp", field: "b", op: "=", value: 1 },
            { type: "cmp", field: "c", op: "=", value: 1 },
          ],
        },
      ],
    });
    expect(ev("a = 1 OR b = 1 AND c = 1", { event: { a: 1, b: 0, c: 0 } })).toBe(true);
    expect(ev("(a = 1 OR b = 1) AND c = 1", { event: { a: 1, b: 0, c: 0 } })).toBe(false);
  });
  it("NOT binds tighter than AND", () => {
    expect(ev("NOT a = 1 AND b = 1", { event: { a: 0, b: 1 } })).toBe(true);
    expect(ev("NOT a = 1 AND b = 1", { event: { a: 1, b: 1 } })).toBe(false);
    expect(ev("NOT (a = 1 AND b = 1)", { event: { a: 1, b: 0 } })).toBe(true);
    expect(parse("NOT a = 1 AND b = 1")).toMatchObject({ type: "and", children: [{ type: "not" }, { type: "cmp" }] });
  });
  it("nested NOT", () => {
    expect(ev("NOT NOT a = 1", T)).toBe(true);
    expect(ev("NOT NOT NOT a = 1", T)).toBe(false);
    expect(ev("NOT (NOT (a = 1 OR b = 2))", T)).toBe(true);
  });
  it("flattens chains", () => {
    expect(parse("a=1 AND b=2 AND c=3")).toMatchObject({ type: "and", children: [{}, {}, {}] });
    expect(parse("a=1 OR b=2 OR c=3")).toMatchObject({ type: "or", children: [{}, {}, {}] });
  });
  it("keywords are case-insensitive", () => {
    expect(ev("a = 1 and b = 1", T)).toBe(true);
    expect(ev("a = 0 Or b = 1", T)).toBe(true);
    expect(ev("nOt a = 0", T)).toBe(true);
    expect(ev("a CONTAINS 1", { event: { a: "x1" } })).toBe(true);
    expect(ev("a IN [1, 2]", T)).toBe(true);
    expect(ev("a Matches 1*", { event: { a: "1x" } })).toBe(true);
    expect(ev("a = 0", F)).toBe(true);
  });
  it("whitespace and no-space operators", () => {
    expect(ev("a=1 AND(b=1)", T)).toBe(true);
    expect(ev("  a  >=  1\n AND\tb<=1 ", T)).toBe(true);
    expect(ev("a in[1,2]", T)).toBe(true);
  });
});

describe("empty filter", () => {
  it("parses to null and matches all", () => {
    expect(parse("")).toBeNull();
    expect(parse("   \n\t ")).toBeNull();
    expect(evaluate(null, {})).toBe(true);
    expect(print(null)).toBe("");
    expect(tryParse("  ")).toEqual({ ok: true, tree: null });
  });
});

describe("syntax errors", () => {
  const cases: [string, string, number][] = [
    ["alert.severity = critical AND title =", 'Expected a value after "=" at position 38', 38],
    ["a = ", 'Expected a value after "=" at position 5', 5],
    ["a contains )", 'Expected a value after "contains" at position 12', 12],
    ["a foo 1", 'Unknown operator "foo" at position 3. Expected =, !=, >, >=, <, <=, contains, in or matches', 3],
    ["a ~ 1", 'Unknown operator "~" at position 3. Expected =, !=, >, >=, <, <=, contains, in or matches', 3],
    ["a ! 1", 'Unknown operator "!" at position 3. Expected =, !=, >, >=, <, <=, contains, in or matches', 3],
    ["a", 'Expected an operator after "a" at position 2', 2],
    ['a = "abc', "Missing closing quote for the text starting at position 5", 5],
    ["(a = 1 AND b = 2", 'Missing ")" to close the "(" at position 1', 1],
    ["a = 1)", 'Unexpected ")" at position 6', 6],
    ["a = 1 AND )", 'Unexpected ")" at position 11', 11],
    ["a in [1, 2", 'Missing "]" to close the list opened at position 6', 6],
    ["a in [1 2]", 'Missing "]" to close the list opened at position 6', 6],
    ["a in 1", 'Expected a list like [a, b] after "in" at position 6', 6],
    ["a in", 'Expected a list like [a, b] after "in" at position 5', 5],
    ["a in [1,]", 'Expected a value after "," at position 9', 9],
    ["a = 1 b = 2", 'Unexpected "b" at position 7. Expected AND, OR or the end of the filter', 7],
    ["a = 1 AND", "Expected a field name at position 10", 10],
    ["AND a = 1", "Expected a field name at position 1", 1],
    ["a..b = 1", "Expected a field name at position 1", 1],
    ['"a" = 1', "Expected a field name at position 1", 1],
    ["NOT", "Expected a field name at position 4", 4],
    ["()", 'Unexpected ")" at position 2', 2],
    ["(a = 1 b = 2)", 'Unexpected "b" at position 8. Expected AND, OR or ")"', 8],
  ];
  it.each(cases)("%s", (text, message, position) => {
    const r = tryParse(text);
    expect(r).toEqual({ ok: false, error: { message, position } });
    expect(() => parse(text)).toThrow(FilterSyntaxError);
    try {
      parse(text);
    } catch (e) {
      expect((e as FilterSyntaxError).position).toBe(position);
      expect((e as FilterSyntaxError).message).toBe(message);
    }
  });
  it("rejects non-finite numbers", () => {
    expect(tryParse("x = 1e400")).toEqual({ ok: false, error: { message: "Number is too large at position 5", position: 5 } });
    expect(tryParse("x in [1, -1e999]")).toMatchObject({ ok: false, error: { position: 10 } });
  });
  it("exact UI example", () => {
    expect(tryParse("alert.severity =")).toEqual({
      ok: false,
      error: { message: 'Expected a value after "=" at position 17', position: 17 },
    });
  });
  it("UI example format", () => {
    expect(tryParse("alert.severity = critical AND title =")).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/^Expected a value after "=" at position \d+$/) },
    });
  });
  it("deep nesting does not crash", () => {
    const r = tryParse("(".repeat(5000) + "a = 1" + ")".repeat(5000));
    expect(r.ok).toBe(false);
  });
});

describe("values and quoting", () => {
  it("parses value forms", () => {
    expect(parse("a = -5")).toEqual({ type: "cmp", field: "a", op: "=", value: -5 });
    expect(parse("a = 1.25")).toEqual({ type: "cmp", field: "a", op: "=", value: 1.25 });
    expect(parse("a = pricing-engine-*")).toEqual({ type: "cmp", field: "a", op: "=", value: "pricing-engine-*" });
    expect(parse('a = "5"')).toEqual({ type: "cmp", field: "a", op: "=", value: "5" });
    expect(parse('a = "x \\"q\\" \\\\"')).toEqual({ type: "cmp", field: "a", op: "=", value: 'x "q" \\' });
    expect(parse('a in [x, "b c", 3]')).toEqual({ type: "in", field: "a", values: ["x", "b c", 3] });
    expect(parse("a in []")).toEqual({ type: "in", field: "a", values: [] });
  });
  it("quotes only when needed", () => {
    const p = (value: string | number) => print({ type: "cmp", field: "a", op: "=", value });
    expect(p("timeout")).toBe("a = timeout");
    expect(p("pricing-engine-*")).toBe("a = pricing-engine-*");
    expect(p("a b")).toBe('a = "a b"');
    expect(p("AND")).toBe('a = "AND"');
    expect(p("in")).toBe('a = "in"');
    expect(p("5")).toBe('a = "5"');
    expect(p("")).toBe('a = ""');
    expect(p("x,y")).toBe('a = "x,y"');
    expect(p('q"q')).toBe('a = "q\\"q"');
    expect(p(5)).toBe("a = 5");
    expect(p(-2.5)).toBe("a = -2.5");
  });
});

describe("print", () => {
  it("canonical form", () => {
    expect(print(parse("a=1 and b CONTAINS x or not c IN [1,2]"))).toBe("a = 1 AND b contains x OR NOT c in [1, 2]");
    expect(print(parse("(a=1 or b=2) and c=3"))).toBe("(a = 1 OR b = 2) AND c = 3");
    expect(print(parse("(a=1 and b=2) or c=3"))).toBe("a = 1 AND b = 2 OR c = 3");
    expect(print(parse("not (a=1 and b=2)"))).toBe("NOT (a = 1 AND b = 2)");
    expect(print(parse("((a=1))"))).toBe("a = 1");
  });
});

describe("round trips", () => {
  const exprs = [
    "a = 1",
    "alert.severity >= error",
    "alert.severity = critical AND alert.environment = prod",
    "a = 1 OR b = 2 AND c = 3",
    "(a = 1 OR b = 2) AND c = 3",
    "NOT a = 1 AND b = 2",
    "NOT (a = 1 OR b = 2)",
    "NOT NOT a = 1",
    "NOT (NOT (a = 1 AND b = 2) OR c = 3)",
    'title contains "disk full"',
    "payload.notional > 10000000",
    "payload.x <= -3.5",
    'a in [x, "y z", 3, -4.5]',
    "a in []",
    "name matches pricing-engine-*",
    'a = "5"',
    'a = "AND"',
    'a = "he said \\"hi\\""',
    'a = "back\\\\slash"',
    'a = ""',
    "a = x1 and b = x2 and c = x3",
    "a = 1 or b = 2 or c = 3",
    "((a = 1 AND b = 2) OR (c = 3 AND d = 4)) AND NOT e in [1, 2]",
    "(a = 1 AND b = 2) AND c = 3",
    "a = 1 AND (b = 2 AND c = 3)",
    "a = 1 OR (b = 2 OR c = 3)",
    "x.y-z_w != foo:bar/baz@qux",
    "a = 1e+21",
    'a = "(x)" OR b = "[y]" OR c = "a,b" OR d = "<>" OR e = "!="',
    "A.B = C",
  ];
  it.each(exprs)("fixed point: %s", (s) => {
    const t = parse(s);
    const once = print(t);
    expect(print(parse(once))).toBe(once);
    expect(parse(once)).toEqual(t);
  });
  const trees: FilterNode[] = [
    { type: "and", children: [{ type: "and", children: [c("a"), c("b")] }, c("c")] },
    { type: "or", children: [c("a"), { type: "or", children: [c("b"), c("c")] }] },
    { type: "not", child: { type: "not", child: c("a") } },
    { type: "not", child: { type: "or", children: [c("a"), c("b")] } },
    { type: "and", children: [{ type: "or", children: [c("a"), c("b")] }, { type: "not", child: c("c") }] },
    { type: "in", field: "a", values: ["1", 1, "and", "x y", ""] },
    { type: "cmp", field: "a", op: "matches", value: "a*?" },
    { type: "cmp", field: "a", op: "=", value: "\\" },
    { type: "cmp", field: "a", op: "=", value: "line\nbreak" },
  ];
  function c(f: string): FilterNode {
    return { type: "cmp", field: f, op: "=", value: "v" };
  }
  it.each(trees.map((t) => [print(t), t] as const))("tree: %s", (_s, t) => {
    expect(parse(print(t))).toEqual(t);
    expect(JSON.parse(JSON.stringify(t))).toEqual(t);
  });
});

describe("validateTree", () => {
  it("accepts good trees", () => {
    const t = parse('a = 1 AND NOT (b in [x, 2] OR c matches "p*")')!;
    expect(validateTree(JSON.parse(JSON.stringify(t)))).toEqual(t);
  });
  const bad: [unknown, RegExp][] = [
    [null, /expected an object/],
    ["x", /expected an object/],
    [[], /expected an object/],
    [{}, /"type" must be one of/],
    [{ type: "xor" }, /"type" must be one of/],
    [{ type: "and", children: [] }, /at least 2/],
    [{ type: "and", children: [{ type: "cmp", field: "a", op: "=", value: 1 }] }, /at least 2/],
    [{ type: "not" }, /\$\.child: expected an object/],
    [{ type: "cmp", field: "AND", op: "=", value: 1 }, /not a valid field name/],
    [{ type: "cmp", field: "a b", op: "=", value: 1 }, /not a valid field name/],
    [{ type: "cmp", field: "a", op: "~", value: 1 }, /"op" must be one of/],
    [{ type: "cmp", field: "a", op: "=", value: null }, /value must be/],
    [{ type: "cmp", field: "a", op: "=", value: NaN }, /value must be/],
    [{ type: "cmp", field: "a", op: "=", value: { x: 1 } }, /value must be/],
    [{ type: "in", field: "a", values: "x" }, /must be an array/],
    [{ type: "in", field: "a", values: [1, true] }, /values\[1\]/],
    [{ type: "or", children: [{ type: "cmp", field: "a", op: "=", value: 1 }, { type: "bogus" }] }, /\$\.children\[1\]/],
  ];
  it.each(bad)("rejects %j", (json, re) => {
    expect(() => validateTree(json)).toThrow(re);
  });
  it("rejects absurd depth", () => {
    let t: unknown = { type: "cmp", field: "a", op: "=", value: 1 };
    for (let i = 0; i < 500; i++) t = { type: "not", child: t };
    expect(() => validateTree(t)).toThrow(/too deeply/);
  });
  it("strips unknown properties", () => {
    expect(validateTree({ type: "cmp", field: "a", op: "=", value: 1, extra: 1 })).toEqual({ type: "cmp", field: "a", op: "=", value: 1 });
  });
});

describe("autocomplete support", () => {
  it("exports lists", () => {
    expect(COMMON_FIELDS).toContain("alert.severity");
    expect(COMMON_FIELDS).toHaveLength(10);
    expect([...KEYWORDS]).toEqual(["AND", "OR", "NOT"]);
    expect(OPERATORS.map((o) => o.symbol)).toEqual(["=", "!=", ">", ">=", "<", "<=", "contains", "in", "matches"]);
    for (const o of OPERATORS) expect(o.description.length).toBeGreaterThan(3);
  });
  it.each([
    ["", { expect: "field", prefix: "" }],
    ["ale", { expect: "field", prefix: "ale" }],
    ["alert.severity ", { expect: "operator", prefix: "" }],
    ["alert.severity", { expect: "field", prefix: "alert.severity" }],
    ["alert.severity con", { expect: "operator", prefix: "con" }],
    ["alert.severity >", { expect: "operator", prefix: ">" }],
    ["alert.severity = ", { expect: "value", field: "alert.severity", prefix: "" }],
    ["alert.severity =cr", { expect: "value", field: "alert.severity", prefix: "cr" }],
    ["alert.severity = critical ", { expect: "logic", prefix: "" }],
    ["alert.severity = critical an", { expect: "logic", prefix: "an" }],
    ["a = 1 AND ", { expect: "field", prefix: "" }],
    ["a = 1 or t", { expect: "field", prefix: "t" }],
    ["(", { expect: "field", prefix: "" }],
    ["NOT ", { expect: "field", prefix: "" }],
    ["(a = 1) ", { expect: "logic", prefix: "" }],
    ["(a = 1 AND b = 2) OR ", { expect: "field", prefix: "" }],
    ["a in ", { expect: "value", field: "a", prefix: "" }],
    ["a in [", { expect: "value", field: "a", prefix: "" }],
    ["a in [x, ", { expect: "value", field: "a", prefix: "" }],
    ["a in [x] ", { expect: "logic", prefix: "" }],
    ['a = "par', { expect: "value", field: "a", prefix: "par" }],
    ["a contains ", { expect: "value", field: "a", prefix: "" }],
  ])("%j", (text, want) => {
    expect(suggestContext(text)).toEqual(want);
  });
  it("respects cursor and never throws", () => {
    expect(suggestContext("a = 1 AND b", 5)).toEqual({ expect: "value", field: "a", prefix: "1" });
    expect(suggestContext("a = 1", -5)).toEqual({ expect: "field", prefix: "" });
    expect(suggestContext("a = 1 ", 999)).toEqual({ expect: "logic", prefix: "" });
    for (const s of ['"', "((((", "))]]", "!", "a !", "\u0000\ud800", "a in [[[", "= = ="]) {
      for (let i = -1; i <= s.length + 1; i++) expect(() => suggestContext(s, i)).not.toThrow();
    }
  });
});

describe("dates", () => {
  const now = Date.parse("2026-11-21T12:00:00Z");
  const at = (lastSeen: unknown) => ({ alert: { lastSeen }, event: { ts: 1795262400000, sec: 1795262400 }, now });
  it("relative values: now, now-24h, now-7d", () => {
    expect(ev("alert.lastSeen >= now-24h", at("2026-11-21T09:00:00Z"))).toBe(true);
    expect(ev("alert.lastSeen >= now-24h", at("2026-11-19T09:00:00Z"))).toBe(false);
    expect(ev("alert.lastSeen > now-7d", at("2026-11-19T09:00:00Z"))).toBe(true);
    expect(ev("alert.lastSeen < now-1h", at("2026-11-21T11:30:00Z"))).toBe(false);
    expect(ev("alert.lastSeen <= now", at("2026-11-21T11:30:00Z"))).toBe(true);
    expect(ev("alert.lastSeen >= NOW-30m", at("2026-11-21T11:45:00Z"))).toBe(true);
  });
  it("ISO dates on both sides, epoch s and ms on the field side", () => {
    expect(ev("alert.lastSeen >= 2026-11-21", at("2026-11-21T09:00:00Z"))).toBe(true);
    expect(ev('alert.lastSeen < "2026-11-21T08:00:00Z"', at("2026-11-21T09:00:00Z"))).toBe(false);
    expect(ev("ts >= 2026-11-21", at(null))).toBe(true);
    expect(ev("sec >= 2026-11-21", at(null))).toBe(true);
  });
  it("non-dates never match a date comparison", () => {
    expect(ev("alert.lastSeen >= now-24h", at("yesterday"))).toBe(false);
    expect(ev("alert.lastSeen >= now-24h", at(undefined))).toBe(false);
    expect(ev("alert.lastSeen >= now-24x", at("2026-11-21T09:00:00Z"))).toBe(false);
  });
  it("round-trips through print", () => {
    expect(print(parse("alert.lastSeen >= now-24h"))).toBe("alert.lastSeen >= now-24h");
    expect(COMMON_FIELDS).toContain("alert.lastSeen");
    expect(COMMON_FIELDS).toContain("alert.firstSeen");
  });
});
