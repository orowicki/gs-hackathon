import { Kafka, logLevel } from "kafkajs";
import { describe, expect, it, vi } from "vitest";
import {
  KAFKA_CONFIG_SCHEMA,
  createKafkaPlugin,
  kafkaPlugin,
  normalizeKafkaConfig,
  type KafkaConsumerLike,
} from "../src/index.js";

type Payload = Parameters<Parameters<KafkaConsumerLike["run"]>[0]["eachMessage"]>[0];

function mockConsumer() {
  let each!: (p: Payload) => Promise<void>;
  const c = {
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    subscribe: vi.fn(async () => undefined),
    run: vi.fn(async (a: { eachMessage: typeof each }) => void (each = a.eachMessage)),
    commitOffsets: vi.fn(async () => undefined),
    pause: vi.fn(),
    resume: vi.fn(),
    seek: vi.fn(),
    on: vi.fn(),
    events: { CRASH: "consumer.crash" },
  };
  const deliver = (value: string | null, offset = "7", ts = "1700000000000") =>
    each({
      topic: "t",
      partition: 2,
      message: { value: value === null ? null : Buffer.from(value), offset, timestamp: ts },
    } as unknown as Payload);
  return { c, deliver };
}

const cfg = { brokers: "b:9092", topic: "t", groupId: "g" };
const ctx = { sourceId: "s" };

describe("kafka config", () => {
  it("schema requires brokers, topic, groupId; groupId defaults to alerting", () => {
    expect(KAFKA_CONFIG_SCHEMA.required).toEqual(["brokers", "topic", "groupId"]);
    const props = KAFKA_CONFIG_SCHEMA.properties as Record<string, { default?: unknown; title?: string; description?: string }>;
    expect(props.groupId?.default).toBe("alerting");
    expect(props.fromBeginning?.default).toBe(false);
    for (const p of Object.values(props)) {
      expect(p.title).toBeTruthy();
      expect(p.description).toBeTruthy();
    }
    expect(kafkaPlugin.type).toBe("kafka");
  });
  it("applies defaults and splits brokers", () => {
    expect(normalizeKafkaConfig({ brokers: "a:1, b:2", topic: "t" })).toEqual({
      brokers: ["a:1", "b:2"],
      topic: "t",
      groupId: "alerting",
      fromBeginning: false,
    });
  });
  it("rejects missing or malformed fields", () => {
    expect(() => normalizeKafkaConfig({ topic: "t" })).toThrow(/brokers/);
    expect(() => normalizeKafkaConfig({ brokers: "a:1" })).toThrow(/topic/);
    expect(() => normalizeKafkaConfig({ brokers: " , ", topic: "t" })).toThrow(/brokers/);
    expect(() => normalizeKafkaConfig({ brokers: "a:1", topic: "t", fromBeginning: "yes" })).toThrow(/fromBeginning/);
  });
  it("start rejects an invalid config", async () => {
    const p = createKafkaPlugin(() => mockConsumer().c);
    await expect(p.start({ brokers: "", topic: "t" }, async () => undefined, ctx)).rejects.toThrow(/brokers/);
  });
});

describe("kafka plugin (mocked client)", () => {
  it("emits the value with the message timestamp, then commits offset + 1 with autoCommit off", async () => {
    const { c, deliver } = mockConsumer();
    const order: string[] = [];
    c.commitOffsets.mockImplementation(async () => void order.push("commit"));
    const emit = vi.fn(async () => void order.push("emit"));
    const h = await createKafkaPlugin(() => c).start(cfg, emit, ctx);
    expect(c.run.mock.calls[0]?.[0]).toMatchObject({ autoCommit: false });
    expect(c.subscribe).toHaveBeenCalledWith({ topic: "t", fromBeginning: false });
    await deliver('{"a":1}');
    expect(emit).toHaveBeenCalledWith('{"a":1}', { receivedAt: "2023-11-14T22:13:20.000Z" });
    expect(order).toEqual(["emit", "commit"]);
    expect(c.commitOffsets).toHaveBeenCalledWith([{ topic: "t", partition: 2, offset: "8" }]);
    await h.stop();
  });

  it("emit failure: no commit, partition paused and rewound, resumed after a delay", async () => {
    vi.useFakeTimers();
    try {
      const { c, deliver } = mockConsumer();
      let fail = true;
      const emit = vi.fn(async (): Promise<void> => {
        if (fail) throw new Error("boom");
      });
      const error = vi.fn();
      const h = await createKafkaPlugin(() => c).start(cfg, emit, { ...ctx, logger: { info: vi.fn(), warn: vi.fn(), error } });
      await deliver("x");
      expect(c.commitOffsets).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalled();
      expect(c.pause).toHaveBeenCalledWith([{ topic: "t", partitions: [2] }]);
      expect(c.seek).toHaveBeenCalledWith({ topic: "t", partition: 2, offset: "7" });
      expect(c.resume).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(500);
      expect(c.resume).toHaveBeenCalledWith([{ topic: "t", partitions: [2] }]);
      // redelivery now succeeds
      fail = false;
      await deliver("x");
      expect(c.commitOffsets).toHaveBeenCalledTimes(1);
      await h.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("tombstones are not emitted but are committed", async () => {
    const { c, deliver } = mockConsumer();
    const emit = vi.fn(async () => undefined);
    const h = await createKafkaPlugin(() => c).start(cfg, emit, ctx);
    await deliver(null, "3");
    expect(emit).not.toHaveBeenCalled();
    expect(c.commitOffsets).toHaveBeenCalledWith([{ topic: "t", partition: 2, offset: "4" }]);
    await h.stop();
  });

  it("stop() disconnects, and is idempotent", async () => {
    const { c } = mockConsumer();
    const h = await createKafkaPlugin(() => c).start(cfg, async () => undefined, ctx);
    await h.stop();
    await h.stop();
    expect(c.disconnect).toHaveBeenCalledTimes(1);
  });

  it("a failing connect does not throw from start and is retried", async () => {
    vi.useFakeTimers();
    try {
      const bad = mockConsumer();
      bad.c.connect.mockImplementation(async () => {
        throw new Error("down");
      });
      const good = mockConsumer();
      const consumers = [bad.c, good.c];
      const h = await createKafkaPlugin(() => consumers.shift() as KafkaConsumerLike).start(cfg, async () => undefined, ctx);
      expect(good.c.connect).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2100);
      expect(good.c.run).toHaveBeenCalled();
      await h.stop();
      expect(good.c.disconnect).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

const BROKERS = process.env.KAFKA_BROKERS ?? "localhost:19092";

async function reachable(): Promise<boolean> {
  const admin = new Kafka({
    brokers: BROKERS.split(","),
    connectionTimeout: 1000,
    requestTimeout: 1500,
    retry: { retries: 0 },
    logLevel: logLevel.NOTHING,
  }).admin();
  try {
    await admin.connect();
    return true;
  } catch {
    return false;
  } finally {
    await admin.disconnect().catch(() => undefined);
  }
}

const up = await reachable();

describe.skipIf(!up)("kafka (needs a broker: KAFKA_BROKERS or localhost:19092)", () => {
  it("produce -> emit", async () => {
    const topic = `test.ingest.${Date.now()}`;
    const kafka = new Kafka({ brokers: BROKERS.split(","), logLevel: logLevel.NOTHING });
    const admin = kafka.admin();
    await admin.connect();
    await admin.createTopics({ topics: [{ topic, numPartitions: 1 }] });
    await admin.disconnect();
    const got: unknown[] = [];
    const h = await kafkaPlugin.start(
      { brokers: BROKERS, topic, groupId: `g-${Date.now()}`, fromBeginning: true },
      async (m) => void got.push(m),
      ctx,
    );
    const producer = kafka.producer();
    await producer.connect();
    await producer.send({ topic, messages: [{ value: '{"hello":"kafka"}' }] });
    await producer.disconnect();
    const end = Date.now() + 30_000;
    while (got.length < 1 && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    await h.stop();
    expect(got).toEqual(['{"hello":"kafka"}']);
  }, 45_000);
});
