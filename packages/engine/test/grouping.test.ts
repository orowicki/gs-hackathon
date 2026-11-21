import { beforeEach, describe, expect, it } from "vitest";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import type { Alert, Event, Notification, Rule } from "@alerting/shared";
import { createGrouping, groupingOf, parseDuration, type GroupingContext } from "../src/index.js";

const note = (i: number, over: Partial<Notification> = {}): Notification => ({
  id: `n${i}`,
  alertId: `a${i}`,
  recipientId: "bob",
  channel: "ntfy",
  severity: "warning",
  title: `Alert ${i}`,
  clickUrl: `http://x/alerts/a${i}`,
  attempt: 0,
  createdAt: "2026-01-01T00:00:00Z",
  ...over,
});

const ctx = (host = "h1", rule: Partial<Rule> = { groupBy: ["environment", "host"], groupWindow: "1m" }): GroupingContext => ({
  rule: { rule: { id: "r1", name: "Disk", ...rule } as Rule },
  alert: { environment: "prod", source: "s" } as Alert,
  event: { id: "e", parsed: { host }, common: {}, raw: "" } as unknown as Event,
});

describe("grouping", () => {
  let redis: Redis;
  let sent: Notification[];
  let clock: number;
  const mk = (r: Redis = redis) =>
    createGrouping({ redis: r, deliver: (n) => void sent.push(n), now: () => clock });
  beforeEach(async () => {
    redis = new RedisMock() as unknown as Redis;
    await redis.flushall();
    sent = [];
    clock = Date.now();
  });

  it("bundles a burst into one notification per recipient", async () => {
    const g = mk();
    for (let i = 0; i < 3; i++) {
      expect(await g.beforeEnqueue(note(i), ctx())).toBeNull();
      expect(await g.beforeEnqueue(note(i, { id: `m${i}`, recipientId: "amy", severity: i === 1 ? "critical" : "warning" }), ctx())).toBeNull();
    }
    expect(await g.flushDue(clock + 1000)).toBe(0);
    expect(sent).toHaveLength(0);
    expect(await g.flushDue(clock + 60_000)).toBe(2);
    expect(sent).toHaveLength(2);
    const bob = sent.find((n) => n.recipientId === "bob")!;
    const amy = sent.find((n) => n.recipientId === "amy")!;
    expect(bob.title).toBe("3 alerts: Disk");
    expect(bob.digestAlertIds).toEqual(["a0", "a1", "a2"]);
    expect(amy.severity).toBe("critical");
    expect(await g.flushDue(clock + 200_000)).toBe(0);
  });

  it("separates different group values", async () => {
    const g = mk();
    await g.beforeEnqueue(note(0), ctx("h1"));
    await g.beforeEnqueue(note(1), ctx("h1"));
    await g.beforeEnqueue(note(2), ctx("h2"));
    await g.flushDue(clock + 60_000);
    expect(sent).toHaveLength(2);
    expect(sent.find((n) => n.digestAlertIds)?.digestAlertIds).toEqual(["a0", "a1"]);
    expect(sent.find((n) => !n.digestAlertIds)?.id).toBe("n2"); // single item unchanged
  });

  it("starts a new group after the window was flushed", async () => {
    const g = mk();
    await g.beforeEnqueue(note(0), ctx());
    await g.flushDue(clock + 60_000);
    clock += 90_000;
    await g.beforeEnqueue(note(1), ctx());
    await g.beforeEnqueue(note(2), ctx());
    expect(await g.flushDue(clock + 59_000)).toBe(0);
    expect(await g.flushDue(clock + 60_000)).toBe(1);
    expect(sent.map((n) => n.title)).toEqual(["Alert 0", "2 alerts: Disk"]);
  });

  it("passes notifications of rules without active grouping", async () => {
    const g = mk();
    const n = note(0);
    expect(await g.beforeEnqueue(n, ctx("h", {}))).toBe(n);
    expect(await g.beforeEnqueue(n, ctx("h", { groupBy: ["host"] }))).toBe(n);
    expect(await g.beforeEnqueue(n, ctx("h", { groupBy: [], groupWindow: "1m" }))).toBe(n);
    expect(await g.beforeEnqueue(n, ctx("h", { groupBy: ["host"], groupWindow: "soon" }))).toBe(n);
  });

  it("lists at most 10 titles", async () => {
    const g = mk();
    for (let i = 0; i < 12; i++) await g.beforeEnqueue(note(i), ctx());
    await g.flushDue(clock + 60_000);
    expect(sent[0]!.body!.split("\n")).toHaveLength(11);
    expect(sent[0]!.body).toContain("and 2 more");
  });

  it("delivers a group once with two instances", async () => {
    const g1 = mk();
    const g2 = mk();
    for (let i = 0; i < 3; i++) await g1.beforeEnqueue(note(i), ctx());
    await Promise.all([g1.flushDue(clock + 60_000), g2.flushDue(clock + 60_000)]);
    expect(sent).toHaveLength(1);
  });

  it("parses durations", () => {
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("5m")).toBe(300_000);
    expect(parseDuration("1h")).toBe(3_600_000);
    for (const bad of ["", "5", "m", "1d", "-5s", "1.5s", "0s", "5 m x", undefined, 5]) expect(parseDuration(bad)).toBeNull();
    expect(groupingOf({ groupBy: ["a"], groupWindow: "x" } as Rule)).toBeNull();
  });
});
