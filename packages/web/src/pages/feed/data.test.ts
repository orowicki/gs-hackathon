import type { Alert } from "@alerting/shared";
import { describe, expect, it, vi } from "vitest";
import { createHttpSource, createSource, isDemoSource, probeApi, wantsMock } from "./data";
import { seedAlerts } from "./mockSource";

const res = (status: number, body: unknown) =>
  Promise.resolve(new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));

describe("probeApi", () => {
  it("returns alerts when the API answers with a list", async () => {
    const list = seedAlerts();
    const fetchFn = vi.fn(() => res(200, list)) as unknown as typeof fetch;
    const p = await probeApi(fetchFn);
    expect(p).toEqual({ ok: true, alerts: list });
  });
  it("falls back on 404, non-JSON, non-list and network errors", async () => {
    expect((await probeApi((() => res(404, "nope")) as typeof fetch)).ok).toBe(false);
    expect((await probeApi((() => res(200, "<html>")) as typeof fetch)).ok).toBe(false);
    expect((await probeApi((() => res(200, { a: 1 })) as typeof fetch)).ok).toBe(false);
    expect((await probeApi((() => Promise.reject(new Error("down"))) as typeof fetch)).ok).toBe(false);
  });
  it("falls back on 502, 503 and 504 (proxy without backend)", async () => {
    for (const code of [502, 503, 504]) expect((await probeApi((() => res(code, "x")) as typeof fetch)).ok).toBe(false);
  });
  it("throws on server errors", async () => {
    await expect(probeApi((() => res(500, "x")) as typeof fetch)).rejects.toThrow(/500/);
  });
});

describe("sources", () => {
  it("http source serves the primed list sorted, then refetches", async () => {
    const list = seedAlerts().reverse();
    const fresh = seedAlerts().slice(0, 1);
    const fetchFn = vi.fn(() => res(200, fresh)) as unknown as typeof fetch;
    const s = createHttpSource(list, fetchFn);
    const first = await s.listAlerts();
    expect(fetchFn).not.toHaveBeenCalled();
    expect(Date.parse(first[0]!.lastSeen)).toBeGreaterThanOrEqual(Date.parse(first[1]!.lastSeen));
    expect(await s.listAlerts()).toHaveLength(1);
  });

  it("createSource uses the mock when the API is absent or ?mock=1", async () => {
    const none = (() => res(404, "")) as typeof fetch;
    const s = await createSource("", none);
    expect((await s.listAlerts()).length).toBeGreaterThan(3);
    const forced = vi.fn() as unknown as typeof fetch;
    await createSource("?mock=1", forced);
    expect(forced).not.toHaveBeenCalled();
    expect(isDemoSource(s)).toBe(true);
    expect(isDemoSource(await createSource("?mock=1", forced))).toBe(true);
    expect(isDemoSource(null)).toBe(false);
    expect(isDemoSource(createHttpSource([], forced))).toBe(false);
    expect(wantsMock("?mock=1")).toBe(true);
    expect(wantsMock("")).toBe(false);
  });
});

describe("alert shape", () => {
  it("fixtures carry the fields the feed renders", () => {
    for (const a of seedAlerts() as Alert[]) {
      expect(a.title).toBeTruthy();
      expect(["open", "acknowledged", "resolved"]).toContain(a.state);
    }
  });
});
