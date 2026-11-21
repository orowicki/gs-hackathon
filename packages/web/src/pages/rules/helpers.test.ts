import { describe, expect, it } from "vitest";
import { buildPayload, buildRule, newWhoDraft, slugify, emptyDraft, filterText, moveRow, parseRecipients, ruleToDraft, shortText, validateDraft } from "./helpers";

describe("rules helpers", () => {
  it("parses recipients", () => {
    expect(parseRecipients("person:a, group:g1, bob")).toEqual([
      { type: "person", id: "a" },
      { type: "group", id: "g1" },
      { type: "person", id: "bob" },
    ]);
  });

  it("builds a payload omitting empty optionals", () => {
    const d = { ...emptyDraft(), name: " N ", when: " alert.severity = critical ", fields: "a, b" };
    d.who = [newWhoDraft({ recipients: "group:oncall", force: "sms, push" })];
    expect(buildPayload(d)).toEqual({
      name: "N",
      enabled: true,
      when: "alert.severity = critical",
      who: [{ recipients: [{ type: "group", id: "oncall" }], force: ["sms", "push"] }],
      looks: { titleTemplate: "{{alert.title}}", fields: ["a", "b"] },
    });
  });

  it("validates", () => {
    expect(validateDraft(emptyDraft())).toEqual(["Name is required."]);
    const d = { ...emptyDraft(), name: "x", who: [newWhoDraft()] };
    expect(validateDraft(d)).toHaveLength(1);
  });

  it("round trips a rule", () => {
    const d = ruleToDraft({
      id: "r1",
      name: "R",
      enabled: false,
      when: { type: "cmp", field: "alert.severity", op: "=", value: "critical" },
      who: [{ condition: "alert.env = prod", recipients: [{ type: "person", id: "p" }] }],
      looks: { titleTemplate: "t", fields: ["x"], colour: "#fff" },
      createdAt: "",
      updatedAt: "",
    });
    expect(d.when).toContain("alert.severity");
    expect(buildPayload(d).who[0]?.condition).toBe("alert.env = prod");
    expect(buildPayload(d).looks.colour).toBe("#fff");
  });

  it("moves rows and shortens text", () => {
    expect(moveRow([1, 2, 3], 0, 1)).toEqual([2, 1, 3]);
    expect(moveRow([1, 2, 3], 0, -1)).toEqual([1, 2, 3]);
    expect(shortText("a".repeat(100), 10)).toHaveLength(10);
    expect(filterText(undefined)).toBe("");
  });

  it("builds full entities for create and update", () => {
    const d = { ...emptyDraft(), id: "r1", name: "N" };
    const created = buildRule(d, { id: "r1", now: "T" });
    expect(created).toMatchObject({ id: "r1", createdAt: "T", updatedAt: "T", name: "N" });
    const loaded = {
      id: "r1", name: "Old", enabled: true, when: "", who: [], looks: { titleTemplate: "t", fields: [] },
      dedupFields: ["source"], createdAt: "C", updatedAt: "U",
    } as never;
    const edited = { ...ruleToDraft(loaded), name: "N" };
    const updated = buildRule(edited, { id: "r1", loaded, now: "T" }) as unknown as Record<string, unknown>;
    expect(updated).toMatchObject({ id: "r1", name: "N", dedupFields: ["source"], createdAt: "C", updatedAt: "T" });
    const cleared = buildRule({ ...edited, dedupFields: "" }, { id: "r1", loaded, now: "T" });
    expect(cleared.dedupFields).toBeUndefined();
    expect(JSON.stringify(updated)).not.toContain("key");
  });

  it("validates ids on create and slugifies", () => {
    expect(slugify("Critical Prod!")).toBe("critical-prod");
    const ok = { ...emptyDraft(), name: "x", id: "ok-1" };
    expect(validateDraft(ok, true)).toEqual([]);
    expect(validateDraft({ ...ok, id: "import" }, true)).toHaveLength(1);
    expect(validateDraft({ ...ok, id: "Bad Id" }, true)).toHaveLength(1);
    expect(validateDraft({ ...ok, id: "" }, false)).toEqual([]);
  });
});
