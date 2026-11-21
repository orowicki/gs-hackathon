import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockSource, seedAlerts } from "./mockSource";

afterEach(() => vi.useRealTimers());

describe("mock source", () => {
  it("seeds newest first with unique ids", () => {
    const a = seedAlerts();
    expect(new Set(a.map((x) => x.id)).size).toBe(a.length);
    for (let i = 1; i < a.length; i++) expect(Date.parse(a[i - 1]!.lastSeen)).toBeGreaterThanOrEqual(Date.parse(a[i]!.lastSeen));
  });

  it("acknowledges and unacknowledges an alert", async () => {
    const s = createMockSource(1000);
    const open = (await s.listAlerts()).find((a) => a.state === "open")!;
    expect((await s.ack!(open.id)).state).toBe("acknowledged");
    const back = await s.unack!(open.id);
    expect(back.state).toBe("open");
    expect(back.acknowledgedAt).toBeUndefined();
    await expect(s.unack!(open.id)).rejects.toThrow("Only acknowledged");
  });

  it("pushes new alerts that sort to the top", async () => {
    vi.useFakeTimers();
    const s = createMockSource(1000);
    const pushes: Array<{ alertId: string; kind: string }> = [];
    const status: boolean[] = [];
    const stop = s.subscribe((p) => pushes.push(p as { alertId: string; kind: string }), (l) => status.push(l));
    expect(status).toEqual([true]);
    vi.advanceTimersByTime(2000);
    stop();
    vi.advanceTimersByTime(5000);
    expect(pushes).toHaveLength(2);
    expect(pushes.map((p) => p.kind)).toEqual(["updated", "created"]);
    const list = await s.listAlerts();
    expect(list[0]!.id).toBe(pushes[1]!.alertId);
    const updated = await s.getAlert(pushes[0]!.alertId);
    expect(updated.count).toBeGreaterThan(1);
    await expect(s.getAlert("missing")).rejects.toThrow();
  });

  it("lists people and persists starred filters per person", async () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    const s = createMockSource();
    expect((await s.listPeople()).some((p) => p.canCreateRules)).toBe(true);
    expect(await s.getStarred("p-rates")).toEqual([]);
    const item = { id: "s1", personId: "p-rates", name: "alert.severity = critical", filter: "alert.severity = critical" };
    await s.putStarred("p-rates", [item]);
    expect(await s.getStarred("p-rates")).toEqual([item]);
    expect(await s.getStarred("p-settlements")).toEqual([]);
    vi.unstubAllGlobals();
  });
});
