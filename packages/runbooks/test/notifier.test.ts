import { describe, expect, it } from "vitest";
import type { Notification } from "@alerting/shared";
import { createGroupNotifier } from "../src/index.js";
import { workflowAlert, workflowEvent } from "./helpers.js";

describe("createGroupNotifier", () => {
  const info = { alertId: "al1", runbookId: "rb", stepIndex: 2, template: { alert: workflowAlert(), event: workflowEvent() } };
  it("enqueues one notification per member and channel", async () => {
    const out: Notification[] = [];
    let n = 0;
    const notify = createGroupNotifier({
      getGroup: async (id) => (id === "g1" ? { id, name: "G", memberIds: ["p1", "p2"] } : undefined),
      enqueue: async (x) => void out.push(x),
      channels: ["ntfy", "ui"],
      newId: () => `n${++n}`,
      now: () => new Date("2026-01-01T00:00:00Z"),
    });
    expect(await notify("g1", info)).toBe("notified group g1 (2 people)");
    expect(out).toHaveLength(4);
    expect(out[0]).toMatchObject({
      id: "n1",
      alertId: "al1",
      recipientId: "p1",
      channel: "ntfy",
      severity: workflowAlert().severity,
      title: workflowAlert().title,
      clickUrl: "/alerts/al1",
      attempt: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });
  it("throws for an unknown group", async () => {
    const notify = createGroupNotifier({ getGroup: async () => undefined, enqueue: async () => {} });
    await expect(notify("nope", info)).rejects.toThrow("group nope not found");
  });
});
