import { beforeEach, describe, expect, it } from "vitest";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import type { Notification } from "@alerting/shared";
import { createThrottle, throttleConfigFromEnv } from "../src/index.js";

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

describe("throttle", () => {
  let redis: Redis;
  let sent: Notification[];
  let clock: number;
  const mk = (max = 3, r: Redis = redis, out: Notification[] = sent) =>
    createThrottle({ redis: r, max, windowMs: 60_000, enqueue: (n) => void out.push(n), now: () => clock });
  beforeEach(async () => {
    redis = new RedisMock() as unknown as Redis;
    await redis.flushall();
    sent = [];
    clock = Date.now();
  });

  it("passes N, buffers the rest, sends one digest when the window ends", async () => {
    const t = mk(3);
    const results = [];
    for (let i = 0; i < 10; i++) results.push(await t.beforeEnqueue(note(i, { severity: i === 7 ? "critical" : "warning" })));
    expect(results.slice(0, 3).every((r) => r !== null)).toBe(true);
    expect(results.slice(3).every((r) => r === null)).toBe(true);

    expect(await t.flushDue(clock + 1000)).toBe(0); // window still open
    expect(sent).toHaveLength(0);
    expect(await t.flushDue(clock + 61_000)).toBe(1);
    expect(sent).toHaveLength(1);
    const d = sent[0]!;
    expect(d.digestAlertIds).toEqual(["a3", "a4", "a5", "a6", "a7", "a8", "a9"]);
    expect(d.severity).toBe("critical");
    expect(d.title).toBe("7 more alerts");
    expect(d.recipientId).toBe("bob");
    expect(d.channel).toBe("ntfy");
    expect(await t.flushDue(clock + 120_000)).toBe(0); // buffer drained
  });

  it("is deterministic for the same bundle and per recipient+channel", async () => {
    const t = mk(0 + 1);
    await t.beforeEnqueue(note(0));
    await t.beforeEnqueue(note(1));
    await t.beforeEnqueue(note(2, { recipientId: "carol" }));
    await t.beforeEnqueue(note(3, { recipientId: "carol" }));
    expect(await t.flushDue(clock + 61_000)).toBe(2);
    expect(sent.map((s) => s.recipientId).sort()).toEqual(["bob", "carol"]);
    expect(sent[0]!.title).toBe("1 more alert");
    expect(new Set(sent.map((s) => s.id)).size).toBe(2);
  });

  it("never throttles ui", async () => {
    const t = mk(1);
    for (let i = 0; i < 20; i++) expect(await t.beforeEnqueue(note(i, { channel: "ui" }))).not.toBeNull();
    expect(await t.flushDue(clock + 120_000)).toBe(0);
  });

  it("lets only one instance send a due digest", async () => {
    const out1: Notification[] = [];
    const out2: Notification[] = [];
    const t1 = mk(1, redis, out1);
    const t2 = mk(1, redis, out2);
    for (let i = 0; i < 5; i++) await t1.beforeEnqueue(note(i));
    const [a, b] = await Promise.all([t1.flushDue(clock + 61_000), t2.flushDue(clock + 61_000)]);
    expect(a + b).toBe(1);
    expect(out1.length + out2.length).toBe(1);
  });

  it("re-buffers the digest when enqueue fails", async () => {
    let fail = true;
    const out: Notification[] = [];
    const t = createThrottle({
      redis,
      max: 1,
      windowMs: 60_000,
      now: () => clock,
      logger: { error() {} },
      enqueue: (n) => {
        if (fail) throw new Error("down");
        out.push(n);
      },
    });
    for (let i = 0; i < 3; i++) await t.beforeEnqueue(note(i));
    expect(await t.flushDue(clock + 61_000)).toBe(0);
    fail = false;
    expect(await t.flushDue(clock + 63_000)).toBe(1);
    expect(out[0]!.digestAlertIds).toEqual(["a1", "a2"]);
  });

  it("a digest is not lost when the sending instance dies, another takes over after the lease", async () => {
    const dead = createThrottle({ redis, max: 1, windowMs: 60_000, now: () => clock, enqueue: () => new Promise(() => {}) });
    for (let i = 0; i < 4; i++) await dead.beforeEnqueue(note(i));
    void dead.flushDue(clock + 61_000); // claims, then hangs forever
    await new Promise((r) => setTimeout(r, 50));
    const t2 = mk(1);
    expect(await t2.flushDue(clock + 62_000)).toBe(0); // still leased
    expect(await t2.flushDue(clock + 61_000 + 31_000)).toBe(1);
    expect(sent[0]!.digestAlertIds).toEqual(["a1", "a2", "a3"]);
    expect(await t2.flushDue(clock + 200_000)).toBe(0);
  });

  it("timer start/stop sends due digests", async () => {
    const out: Notification[] = [];
    const t = createThrottle({ redis, max: 1, windowMs: 50, enqueue: (n) => void out.push(n), tickMs: 20 });
    await t.beforeEnqueue(note(0));
    await t.beforeEnqueue(note(1));
    t.start();
    const end = Date.now() + 3000;
    while (out.length === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    await t.stop();
    expect(out).toHaveLength(1);
  });
});

describe("throttleConfigFromEnv", () => {
  it("defaults to 5 per 10 minutes", () => {
    expect(throttleConfigFromEnv({})).toEqual({ max: 5, windowMs: 600_000 });
  });
  it("reads ENGINE_THROTTLE_MAX and ENGINE_THROTTLE_WINDOW_MIN", () => {
    expect(throttleConfigFromEnv({ ENGINE_THROTTLE_MAX: "2", ENGINE_THROTTLE_WINDOW_MIN: "0.5" })).toEqual({
      max: 2,
      windowMs: 30_000,
    });
  });
  it("ignores invalid values", () => {
    expect(throttleConfigFromEnv({ ENGINE_THROTTLE_MAX: "abc", ENGINE_THROTTLE_WINDOW_MIN: "-1" })).toEqual({
      max: 5,
      windowMs: 600_000,
    });
  });
});
