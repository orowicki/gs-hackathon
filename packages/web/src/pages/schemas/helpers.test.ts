import { describe, expect, it } from "vitest";
import { cleanSchema, describeMatch, generateMatch, SCHEMA_EXAMPLES, testSchema, yamlToSchema } from "./helpers";
import { parse } from "yaml";

describe("schema helpers", () => {
  it("every example matches its own sample and maps a title and severity", () => {
    for (const ex of SCHEMA_EXAMPLES) {
      const sample = JSON.parse(ex.sample);
      const rule = generateMatch(sample, ex.schema.mapping);
      expect(rule, ex.id).not.toBe("");
      const r = testSchema(ex.schema, rule, sample);
      expect(r.matched, ex.id).toBe(true);
      expect(r.common.title, ex.id).toBeTruthy();
      expect(["critical", "error", "warning", "info"], ex.id).toContain(r.common.severity);
    }
  });

  it("writes the which-events rule from the sample and the mapping", () => {
    const wf = { type: "WORKFLOW_FAILED", workflowName: "order-settlement", error: { message: "timeout" } };
    const rule = generateMatch(wf, { title: { kind: "path", path: "workflowName" }, message: { kind: "path", path: "error.message" } });
    expect(rule).toBe("type = WORKFLOW_FAILED AND workflowName matches * AND error.message matches *");
    expect(describeMatch(rule)).toBe("events where type is WORKFLOW_FAILED and that have workflowName and error.message");
    // A type field that feeds severity varies per event, so it isn't pinned.
    const k8s = { type: "Warning", reason: "CrashLoopBackOff" };
    expect(generateMatch(k8s, { severity: { kind: "path", path: "type" }, title: { kind: "path", path: "reason" } })).toBe("reason matches * AND type matches *");
    // Fields with a default are optional; nothing mapped yet falls back to top-level fields.
    expect(generateMatch({ a: 1, b: "x", c: { d: 1 } }, {})).toBe("a matches * AND b matches *");
    expect(generateMatch(undefined, {})).toBe("");
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
