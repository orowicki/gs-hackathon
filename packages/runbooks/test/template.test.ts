import { describe, expect, it } from "vitest";
import { renderTemplate, templateFields } from "../src/index.js";
import { workflowAlert, workflowEvent } from "./helpers.js";

const ctx = () => ({ alert: workflowAlert(), event: workflowEvent() });

describe("renderTemplate", () => {
  it("resolves event paths, alert fields and common fallbacks", () => {
    const out = renderTemplate("{{workflowId}} {{error.code}} {{alert.title}} {{ alert.occurredAt }}", ctx());
    expect(out).toBe(
      "WF-20261023-00042 TIMEOUT order-settlement failed at validate-counterparty 2026-10-23T09:14:02.331Z",
    );
  });
  it("alert.entity falls back to common", () => {
    const alert = { ...workflowAlert(), common: { ...workflowAlert().common, entity: "wf-1" } };
    expect(renderTemplate("{{alert.entity}}", { alert })).toBe("wf-1");
  });
  it("alert.status is the lifecycle state", () => {
    expect(renderTemplate("{{alert.status}}", ctx())).toBe("open");
  });
  it("event.* reads top-level event fields", () => {
    expect(renderTemplate("{{event.id}}", ctx())).toBe("e1");
  });
  it("missing is empty, objects render as JSON, whitespace is allowed", () => {
    expect(renderTemplate("[{{nope}}][{{alert.nope}}]", ctx())).toBe("[][]");
    expect(renderTemplate("{{   error   }}", ctx())).toContain('"code":"TIMEOUT"');
    expect(renderTemplate("{{ workflowId }}", ctx())).toBe("WF-20261023-00042");
    expect(renderTemplate("no event {{workflowId}}.", {})).toBe("no event .");
  });
  it("templateFields lists distinct paths", () => {
    expect(templateFields("{{a}} {{ b.c }} {{a}}")).toEqual(["a", "b.c"]);
  });
});
