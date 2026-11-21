import { describe, expect, it } from "vitest";
import { emptyGroup, emptyPerson, groupPayload, personPayload, toggleMember, validateGroup, validatePerson } from "./model";

describe("people model", () => {
  it("requires name and role", () => {
    expect(Object.keys(validatePerson(emptyPerson())).sort()).toEqual(["name", "role"]);
    expect(validatePerson({ name: "A", role: "SRE", canCreateRules: false })).toEqual({});
  });
  it("validates ntfy topic", () => {
    expect(validatePerson({ name: "A", role: "r", canCreateRules: false, ntfyTopic: "bad topic" }).ntfyTopic).toBeTruthy();
    expect(validatePerson({ name: "A", role: "r", canCreateRules: false, ntfyTopic: "ok_topic-1" })).toEqual({});
  });
  it("trims and drops empty topic", () => {
    expect(personPayload({ name: " A ", role: " r ", canCreateRules: true, ntfyTopic: "  " })).toEqual({
      name: "A",
      role: "r",
      canCreateRules: true,
    });
    expect(personPayload({ name: "A", role: "r", canCreateRules: false, ntfyTopic: " t " }).ntfyTopic).toBe("t");
  });
  it("group validation and payload", () => {
    expect(validateGroup(emptyGroup()).name).toBeTruthy();
    expect(groupPayload({ name: " G ", memberIds: ["a", "a", "b"] })).toEqual({ name: "G", memberIds: ["a", "b"] });
  });
  it("toggles members", () => {
    expect(toggleMember(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleMember(["a", "b"], "a")).toEqual(["b"]);
  });
});
