import { describe, expect, it } from "vitest";
import { buildNtfyBody, classifyStatus, createNtfyChannel, ntfyPriority } from "../src/index.js";
import { note } from "./helpers.js";

const o = { publicUrl: "http://alerts.example/" };

describe("ntfy", () => {
  it("maps priority", () => {
    expect([ntfyPriority("critical"), ntfyPriority("error"), ntfyPriority("warning"), ntfyPriority("info")]).toEqual([5, 4, 3, 2]);
  });

  it("builds body with click and ack action; approve only with approveStepIndex", () => {
    const b = buildNtfyBody(note(1), o) as { topic: string; click: string; priority: number; actions: { label: string; url: string }[] };
    expect(b.topic).toBe("alerting-bob");
    expect(b.click).toBe("http://alerts.example/alerts/a1");
    expect(b.priority).toBe(4);
    expect(b.actions.map((a) => a.label)).toEqual(["Acknowledge"]);
    expect(b.actions[0]!.url).toBe("http://alerts.example/api/alerts/a1/ack");
    const c = buildNtfyBody(note(2, { approveStepIndex: 3, clickUrl: "https://x/y" }), o) as typeof b;
    expect(c.click).toBe("https://x/y");
    expect(c.actions[1]!.label).toBe("Approve");
    expect(c.actions[1]!.url).toBe("http://alerts.example/api/alerts/a2/runbook-steps/3/approve");
  });

  it("appends runbook link", () => {
    const b = buildNtfyBody(note(1, { body: "hi", runbookUrl: "http://rb/1" }), o) as { message: string; actions: { action: string }[] };
    expect(b.message).toBe("hi\nRunbook: http://rb/1");
    expect(b.actions.some((a) => a.action === "view")).toBe(true);
  });

  it("classifies statuses", () => {
    expect(classifyStatus(200)).toEqual({ status: "delivered" });
    expect(classifyStatus(503)).toMatchObject({ retryable: true, unavailable: true });
    expect(classifyStatus(400)).not.toHaveProperty("unavailable");
    expect(classifyStatus(429)).toMatchObject({ retryable: true });
    expect(classifyStatus(400)).toMatchObject({ retryable: false });
    expect(classifyStatus(404)).toMatchObject({ retryable: false });
  });

  it("network error is retryable, 4xx is not", async () => {
    const bad = createNtfyChannel({ baseUrl: "http://x", publicUrl: "http://p", fetch: (() => Promise.reject(new Error("boom"))) as typeof fetch });
    expect(await bad.send(note(1))).toMatchObject({ status: "failed", retryable: true });
    const four = createNtfyChannel({ baseUrl: "http://x", publicUrl: "http://p", fetch: (() => Promise.resolve(new Response("", { status: 403 }))) as typeof fetch });
    expect(await four.send(note(1))).toMatchObject({ status: "failed", retryable: false });
  });

  it("hardens URLs and approve index", () => {
    const b = buildNtfyBody(note(1, { alertId: "a/../b?x", approveStepIndex: -1, clickUrl: "javascript://x", runbookUrl: "ftp://rb" }), o) as {
      click?: string;
      actions: { label: string; url: string }[];
    };
    expect(b.click).toBeUndefined();
    expect(b.actions).toHaveLength(1);
    expect(b.actions[0]!.url).toBe("http://alerts.example/api/alerts/a%2F..%2Fb%3Fx/ack");
    const c = buildNtfyBody(note(1, { approveStepIndex: 1.5 }), o) as typeof b;
    expect(c.actions).toHaveLength(1);
    const d = buildNtfyBody(note(1, { approveStepIndex: 0 }), o) as typeof b;
    expect(d.actions).toHaveLength(2);
  });
});
