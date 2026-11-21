import { describe, expect, it } from "vitest";
import { stripKey, switchAction, withKey } from "./helpers";

describe("runbook step helpers", () => {
  it("switching a step's action keeps its branching (id, if, retries) and approval", () => {
    const s = withKey({ action: "http", name: "Retry", method: "POST", url: "u", approval: "required", approvers: "oncall", id: "retry", if: "steps.check.failed", retries: 2 });
    const w = switchAction(s, "wait");
    expect(stripKey(w)).toEqual({ action: "wait", name: "Retry", duration: "5m", approval: "required", approvers: "oncall", id: "retry", if: "steps.check.failed", retries: 2 });
  });
  it("never saves the editor's internal key", () => {
    expect(stripKey(withKey({ action: "wait", duration: "1m", approval: "none" }))).not.toHaveProperty("key");
  });
});
