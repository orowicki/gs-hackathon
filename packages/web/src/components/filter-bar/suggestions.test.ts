import { describe, expect, it } from "vitest";
import {
  applyReplacement,
  computeSuggestions,
  formatError,
  quoteValue,
  tokenRange,
} from "./suggestions";

const base = { fields: ["payload.region"], valuesFor: () => [] as string[], starred: [] as string[] };

describe("tokenRange", () => {
  it("is empty between tokens", () => {
    expect(tokenRange("a = b ")).toEqual({ start: 6, end: 6 });
    expect(tokenRange("")).toEqual({ start: 0, end: 0 });
  });
  it("covers the word at the cursor, including the rest of it", () => {
    expect(tokenRange("alert.sev", 9)).toEqual({ start: 0, end: 9 });
    expect(tokenRange("alert.sev = x", 5)).toEqual({ start: 0, end: 9 - 0 });
  });
  it("starts after parentheses", () => {
    expect(tokenRange("(ale", 4)).toEqual({ start: 1, end: 4 });
  });
  it("covers operator symbols", () => {
    expect(tokenRange("a >=", 4)).toEqual({ start: 2, end: 4 });
  });
  it("covers an open quote", () => {
    expect(tokenRange('a = "us e', 9)).toEqual({ start: 4, end: 9 });
    expect(tokenRange('a = "us e" and', 7)).toEqual({ start: 4, end: 10 });
  });
  it("clamps the cursor", () => {
    expect(tokenRange("ab", 99)).toEqual({ start: 0, end: 2 });
  });
});

describe("quoteValue", () => {
  it("leaves simple values bare", () => {
    expect(quoteValue("timeout")).toBe("timeout");
    expect(quoteValue("pricing-*")).toBe("pricing-*");
    expect(quoteValue("10")).toBe("10");
  });
  it("quotes spaces, specials, empty and keywords", () => {
    expect(quoteValue("us east")).toBe('"us east"');
    expect(quoteValue("")).toBe('""');
    expect(quoteValue("a,b")).toBe('"a,b"');
    expect(quoteValue("and")).toBe('"and"');
    expect(quoteValue("in")).toBe('"in"');
  });
  it("escapes quotes and backslashes", () => {
    expect(quoteValue('say "hi"')).toBe('"say \\"hi\\""');
    expect(quoteValue("a\\b c")).toBe('"a\\\\b c"');
  });
});

describe("applyReplacement", () => {
  it("replaces the current token", () => {
    expect(applyReplacement("alert.sev", 9, "alert.severity ")).toEqual({
      text: "alert.severity ",
      cursor: 15,
    });
  });
  it("keeps text before and after", () => {
    const r = applyReplacement("a = b AND ale", 13, "alert.title ");
    expect(r.text).toBe("a = b AND alert.title ");
    expect(applyReplacement("x = cr AND y = z", 6, "critical ").text).toBe("x = critical  AND y = z");
  });
  it("replaces an open quoted value", () => {
    expect(applyReplacement('r = "us', 8, '"us east" ').text).toBe('r = "us east" ');
  });
  it("inserts at an empty token", () => {
    expect(applyReplacement("a ", 2, "= ").text).toBe("a = ");
  });
});

describe("computeSuggestions", () => {
  const labels = (s: { label: string }[]) => s.map((x) => x.label);

  it("suggests common fields plus extra fields at the start, alphabetically", () => {
    const s = computeSuggestions({ ...base, text: "" });
    expect(labels(s)).toContain("alert.severity");
    expect(labels(s)).toContain("payload.region");
    expect(labels(s)).toEqual([...labels(s)].sort((a, b) => a.localeCompare(b)));
    expect(s.every((x) => x.kind === "field")).toBe(true);
  });
  it("filters fields by prefix case-insensitively", () => {
    const s = computeSuggestions({ ...base, text: "ALERT.SEV" });
    expect(labels(s)).toEqual(["alert.severity"]);
    expect(s[0]?.insert).toBe("alert.severity ");
  });
  it("suggests operators after a field", () => {
    const s = computeSuggestions({ ...base, text: "alert.severity " });
    expect(labels(s)).toContain("=");
    expect(labels(s)).toContain("contains");
    expect(s[0]?.description).toBeTruthy();
    expect(computeSuggestions({ ...base, text: "alert.severity con" }).map((x) => x.label)).toEqual([
      "contains",
    ]);
  });
  it("suggests values and quotes them", () => {
    const s = computeSuggestions({
      ...base,
      text: "payload.region = ",
      valuesFor: (f) => (f === "payload.region" ? ["eu", "us east"] : []),
    });
    expect(s.map((x) => x.insert)).toEqual(["eu ", '"us east" ']);
  });
  it("filters values by prefix and handles an open quote", () => {
    const vf = () => ["us east", "us west", "eu"];
    expect(labels(computeSuggestions({ ...base, text: 'r = "us e', valuesFor: vf }))).toEqual(["us east"]);
    expect(labels(computeSuggestions({ ...base, text: "r = e", valuesFor: vf }))).toEqual(["eu"]);
  });
  it("suggests logic after a complete condition", () => {
    const s = computeSuggestions({ ...base, text: "a = b " });
    expect(s.map((x) => x.insert)).toEqual([")", "AND ", "OR "].sort((a, b) => a.localeCompare(b)));
    expect(labels(computeSuggestions({ ...base, text: "a = b a" }))).toEqual(["AND"]);
  });
  it("lists matching starred filters first, alphabetically, then completions", () => {
    const s = computeSuggestions({
      ...base,
      text: "alert.s",
      starred: ["z = alert.s", "alert.severity = critical", "unrelated = 1"],
    });
    expect(s.slice(0, 2).map((x) => x.kind)).toEqual(["starred", "starred"]);
    expect(labels(s).slice(0, 2)).toEqual(["alert.severity = critical", "z = alert.s"]);
    expect(labels(s)).not.toContain("unrelated = 1");
    expect(s[2]?.kind).toBe("field");
  });
  it("shows all starred filters for empty text, and hides the one already typed", () => {
    const starred = ["b = 1", "a = 1"];
    expect(labels(computeSuggestions({ ...base, text: "", starred })).slice(0, 2)).toEqual(["a = 1", "b = 1"]);
    expect(labels(computeSuggestions({ ...base, text: "a = 1", starred }))).not.toContain("a = 1");
  });
  it("uses the cursor position", () => {
    const s = computeSuggestions({ ...base, text: "alert.sev = x", cursor: 9 });
    expect(labels(s)).toEqual(["alert.severity"]);
  });
  it("never throws on junk", () => {
    expect(() => computeSuggestions({ ...base, text: '(((" ]]] !!' })).not.toThrow();
  });
});

describe("formatError", () => {
  it("rewrites position to column", () => {
    expect(formatError({ message: 'Expected a value after "=" at position 17', position: 17 })).toBe(
      'Expected a value after "=" at column 17',
    );
  });
  it("appends a column when the message has none", () => {
    expect(formatError({ message: "Something odd.", position: 4 })).toBe("Something odd at column 4");
  });
  it("keeps existing columns", () => {
    expect(formatError({ message: "Bad at column 2", position: 2 })).toBe("Bad at column 2");
  });
});
