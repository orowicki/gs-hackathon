import { describe, expect, it } from "vitest";
import type { Alert, Notification, Runbook } from "@alerting/shared";
import { withRunbookLink } from "./runbook-link.js";

const text = { id: "t", name: "t", type: "text", matches: {}, content: "x" } as unknown as Runbook;
const auto = { id: "a", name: "a", type: "automation", matches: {}, steps: [] } as unknown as Runbook;
const alert = { id: "al1" } as unknown as Alert;
const reg = (list: Runbook[]) => ({ match: () => list });
const note = (extra: Partial<Notification> = {}) => ({ alertId: "al1", ...extra }) as unknown as Notification;

describe("withRunbookLink", () => {
  it("adds the link when a text runbook matches", () => {
    const out = withRunbookLink(note(), { alert }, reg([auto, text]), "https://x.test");
    expect(out.runbookUrl).toBe("https://x.test/alerts/al1#runbook");
  });
  it("leaves the notification alone when nothing matches", () => {
    const n = note();
    expect(withRunbookLink(n, { alert }, reg([]), "https://x.test")).toBe(n);
  });
  it("ignores automation runbooks", () => {
    expect(withRunbookLink(note(), { alert }, reg([auto]), "https://x.test").runbookUrl).toBeUndefined();
  });
  it("keeps an existing runbookUrl", () => {
    const out = withRunbookLink(note({ runbookUrl: "https://own" }), { alert }, reg([text]), "https://x.test");
    expect(out.runbookUrl).toBe("https://own");
  });
  it("skips the link without a publicUrl", () => {
    const n = note();
    expect(withRunbookLink(n, { alert }, reg([text]), "")).toBe(n);
  });
  it("skips digests", () => {
    const n = note({ digestAlertIds: ["al1", "al2"] });
    expect(withRunbookLink(n, { alert }, reg([text]), "https://x.test")).toBe(n);
  });
  it("strips a trailing slash from publicUrl", () => {
    expect(withRunbookLink(note(), { alert }, reg([text]), "https://x.test/").runbookUrl).toBe("https://x.test/alerts/al1#runbook");
  });
  it("returns the notification unchanged when matching throws", () => {
    const n = note();
    const bad = { match: () => { throw new Error("boom"); } };
    expect(withRunbookLink(n, { alert }, bad, "")).toBe(n);
  });
});
