import { describe, expect, it } from "vitest";
import { cleanSchema, SCHEMA_EXAMPLES, testSchema, yamlToSchema } from "./helpers";
import { parse } from "yaml";

describe("schema helpers", () => {
  it("every example matches its own sample and maps a title and severity", () => {
    for (const ex of SCHEMA_EXAMPLES) {
      const r = testSchema(ex.schema, String(ex.schema.match), JSON.parse(ex.sample));
      expect(r.matched, ex.id).toBe(true);
      expect(r.common.title, ex.id).toBeTruthy();
      expect(["critical", "error", "warning", "info"], ex.id).toContain(r.common.severity);
    }
  });

  it("reports a bad match filter instead of throwing", () => {
    const r = testSchema({ id: "x", name: "x", match: "", mapping: {} }, "type = = x", { type: "a" });
    expect(r.matched).toBe(false);
    expect(r.matchError).toBeTruthy();
  });

  it("cleans empty value-map keys and defaults; reads YAML for review", () => {
    const s = cleanSchema(
      { id: "a", name: "A", match: "", mapping: { title: { kind: "path", path: "t", default: "", valueMap: { "": "x" } } } },
      "type = a",
    );
    expect(s.mapping.title).toEqual({ kind: "path", path: "t" });
    expect(() => yamlToSchema("a: [", parse)).toThrow(/valid YAML/);
    expect(yamlToSchema("name: Foo Bar\nmatch: x = 1\n", parse)).toMatchObject({ schema: { id: "foo-bar" }, match: "x = 1" });
  });
});
