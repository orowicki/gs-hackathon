import { describe, expect, it } from "vitest";
import type { Alert, AlertEvent, AutomationRunbook, Runbook } from "@alerting/shared";
import { createAlertEventHandler } from "../src/index.js";
import { workflowAlert, workflowEvent } from "./helpers.js";

const auto = { id: "a", type: "automation" } as unknown as AutomationRunbook;
const text = { id: "t", type: "text" } as unknown as Runbook;
const evt = (kind: AlertEvent["kind"]): AlertEvent => ({ alertId: "x", kind, eventId: "e1", at: "2026-01-01T00:00:00Z" });

function setup(alert: Alert | null = workflowAlert()) {
  const started: string[] = [];
  const handle = createAlertEventHandler({
    registry: { match: () => [auto, text] },
    runner: { start: async (rb) => (started.push(rb.id), {} as never) },
    loadAlert: async () => alert ?? undefined,
    loadEvent: async () => workflowEvent(),
  });
  return { started, handle };
}

describe("alert event handler", () => {
  it("starts matching automation runbooks on created", async () => {
    const s = setup();
    await s.handle(evt("created"));
    expect(s.started).toEqual(["a"]);
  });
  it("ignores other kinds and missing alerts", async () => {
    const s = setup();
    await s.handle(evt("updated"));
    const m = setup(null);
    await m.handle(evt("created"));
    expect(s.started).toEqual([]);
    expect(m.started).toEqual([]);
  });
});
