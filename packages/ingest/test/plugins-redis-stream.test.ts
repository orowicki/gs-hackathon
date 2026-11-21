import { Redis } from "ioredis";
import { describe, expect, it } from "vitest";
import { entryToMessage, redisStreamPlugin } from "../src/index.js";

describe("entryToMessage", () => {
  it("single text field", () =>
    expect(entryToMessage(["data", "hi"])).toBe("hi"));
  it("field map", () =>
    expect(entryToMessage(["a", "1", "b", "2"])).toEqual({ a: "1", b: "2" }));
  it("trimmed pending entry (null fields) yields undefined", () => {
    expect(entryToMessage(null)).toBeUndefined();
    expect(entryToMessage(undefined)).toBeUndefined();
  });
  it("single non-text field is an object", () =>
    expect(entryToMessage(["level", "x"])).toEqual({ level: "x" }));
});

describe.skipIf(!process.env.REDIS_URL)(
  "redis_stream (needs REDIS_URL)",
  () => {
    it("XADD -> emit within 1s, pending entries first", async () => {
      const stream = `test:ingest:${Date.now()}`;
      const r = new Redis(process.env.REDIS_URL as string);
      const got: unknown[] = [];
      const h = await redisStreamPlugin.start(
        { stream, consumerGroup: "g" },
        async (m) => void got.push(m),
        {
          sourceId: "s",
        },
      );
      await r.xadd(stream, "*", "data", "hello");
      await r.xadd(stream, "*", "a", "1", "b", "2");
      const end = Date.now() + 1000;
      while (got.length < 2 && Date.now() < end)
        await new Promise((x) => setTimeout(x, 25));
      await h.stop();
      expect(got).toEqual(["hello", { a: "1", b: "2" }]);
      await r.del(stream);
      r.disconnect();
    });
  },
);
