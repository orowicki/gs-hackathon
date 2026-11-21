import { describe, expect, it } from "vitest";
import type { Runbook } from "@alerting/shared";
import { matchRunbooks, validateRunbook } from "../src/index.js";
import { metricEvent, workflowAlert, workflowEvent } from "./helpers.js";

const rb = (id: string, matches: Runbook["matches"]): Runbook => ({ id, name: id, type: "text", matches, content: "x" });
const ids = (r: Runbook[]) => r.map((x) => x.id);

describe("matchRunbooks", () => {
  const alert = workflowAlert();
  it("text filter on raw paths", () => {
    const books = [rb("a", "type = WORKFLOW_FAILED AND error.code = TIMEOUT")];
    expect(ids(matchRunbooks(books, { alert, event: workflowEvent() }))).toEqual(["a"]);
    expect(matchRunbooks(books, { alert, event: metricEvent() })).toEqual([]);
  });
  it("tree filter and alert fields", () => {
    const tree = { type: "cmp", field: "alert.severity", op: ">=", value: "warning" } as const;
    expect(ids(matchRunbooks([rb("t", tree)], { alert }))).toEqual(["t"]);
    expect(ids(matchRunbooks([rb("s", "alert.status = open AND alert.schema = schema-workflow-failed")], { alert }))).toEqual(["s"]);
    expect(matchRunbooks([rb("s", "alert.status = resolved")], { alert })).toEqual([]);
  });
  it("empty matches everything; bad filter never matches", () => {
    expect(ids(matchRunbooks([rb("e", ""), rb("n", null as never), rb("bad", "type = = x")], { alert }))).toEqual(["e", "n"]);
  });
});

describe("validateRunbook", () => {
  const auto = (steps: unknown) => ({ id: "r", name: "R", type: "automation", matches: "", steps });
  it("accepts text and defaults approval", () => {
    expect(validateRunbook({ id: "r", name: "R", type: "text", matches: "", content: "hi" }).ok).toBe(true);
    const r = validateRunbook(auto([{ action: "wait", duration: "2m" }, { action: "custom" }]));
    expect(r.ok && (r.runbook as { steps: Array<{ approval: string }> }).steps.map((s) => s.approval)).toEqual(["none", "none"]);
  });
  it.each([
    [null],
    [{ name: "R", type: "text", content: "" }],
    [{ id: "r", name: "R", type: "bogus" }],
    [{ id: "r", name: "R", type: "text" }],
    [auto("nope")],
    [auto([{ approval: "none" }])],
    [auto([{ action: "x", approval: "maybe" }])],
    [auto([{ action: "http", method: "POST" }])],
    [auto([{ action: "escalate" }])],
    [auto([{ action: "wait", duration: "soon" }])],
  ])("rejects %j", (x) => {
    expect(validateRunbook(x).ok).toBe(false);
  });
  it("accepts http and escalate", () => {
    expect(validateRunbook(auto([{ action: "http", method: "POST", url: "http://x" }, { action: "escalate", group: "g" }])).ok).toBe(true);
  });
});
