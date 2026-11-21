import { Kafka, logLevel, type EachMessagePayload } from "kafkajs";
import type { SourceContext, SourcePlugin } from "../types.js";
import { KAFKA_CONFIG_SCHEMA } from "./schemas.js";

export interface KafkaConfig {
  /** Comma-separated host:port list. */
  brokers: string;
  topic: string;
  /** Default "alerting". */
  groupId?: string;
  /** Default false. */
  fromBeginning?: boolean;
}

export interface NormalizedKafkaConfig {
  brokers: string[];
  topic: string;
  groupId: string;
  fromBeginning: boolean;
}

/** Validate a source config and fill in defaults. Throws on invalid input. */
export function normalizeKafkaConfig(raw: unknown): NormalizedKafkaConfig {
  const c = (raw ?? {}) as Record<string, unknown>;
  const str = (k: string, required: boolean): string | undefined => {
    const v = c[k];
    if (v === undefined || v === null || v === "") {
      if (required) throw new Error(`kafka config: "${k}" is required`);
      return undefined;
    }
    if (typeof v !== "string")
      throw new Error(`kafka config: "${k}" must be a string`);
    return v.trim();
  };
  const brokers = (str("brokers", true) as string)
    .split(",")
    .map((b) => b.trim())
    .filter(Boolean);
  if (brokers.length === 0)
    throw new Error('kafka config: "brokers" is required');
  const topic = str("topic", true) as string;
  if (!topic) throw new Error('kafka config: "topic" is required');
  const groupId = str("groupId", false) || "alerting";
  const fb = c.fromBeginning;
  if (fb !== undefined && fb !== null && typeof fb !== "boolean")
    throw new Error('kafka config: "fromBeginning" must be a boolean');
  return { brokers, topic, groupId, fromBeginning: fb === true };
}

/** The slice of the kafkajs API this plugin uses (so tests can mock it). */
export interface KafkaConsumerLike {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  subscribe(args: { topic: string; fromBeginning: boolean }): Promise<void>;
  run(args: {
    autoCommit: boolean;
    eachMessage: (p: EachMessagePayload) => Promise<void>;
  }): Promise<void>;
  commitOffsets(
    offsets: { topic: string; partition: number; offset: string }[],
  ): Promise<void>;
  pause(topics: { topic: string; partitions?: number[] }[]): void;
  resume(topics: { topic: string; partitions?: number[] }[]): void;
  seek(args: { topic: string; partition: number; offset: string }): void;
  on(event: string, listener: (e: unknown) => void): unknown;
  events: { CRASH: string };
}
export type KafkaConsumerFactory = (
  config: NormalizedKafkaConfig,
  ctx: SourceContext,
) => KafkaConsumerLike;

const RETRY_DELAY_MS = 500;
const CONNECT_RETRY_MS = 2000;

const defaultFactory: KafkaConsumerFactory = (config, ctx) => {
  const kafka = new Kafka({
    clientId: `alerting-${ctx.sourceId}`,
    brokers: config.brokers,
    retry: { initialRetryTime: 300, maxRetryTime: 30_000, retries: 8 },
    logLevel: logLevel.INFO,
    connectionTimeout: 3000,
    logCreator:
      () =>
      ({ level, log }) => {
        const { message, ...extra } = log;
        const text = `kafka ${message} ${JSON.stringify(extra)}`;
        if (level === logLevel.ERROR) ctx.logger?.error(text);
        else if (level === logLevel.WARN) ctx.logger?.warn(text);
        else if (level === logLevel.INFO) ctx.logger?.info(text);
      },
  });
  return kafka.consumer({
    groupId: config.groupId,
    retry: {
      initialRetryTime: 300,
      maxRetryTime: 30_000,
      retries: 8,
      // Keep trying through broker restarts; never give up the consumer.
      restartOnFailure: async () => true,
    },
  }) as unknown as KafkaConsumerLike;
};

export function createKafkaPlugin(
  factory: KafkaConsumerFactory = defaultFactory,
): SourcePlugin<KafkaConfig> {
  return {
    type: "kafka",
    configSchema: KAFKA_CONFIG_SCHEMA,
    async start(rawConfig, emit, ctx) {
      const config = normalizeKafkaConfig(rawConfig);
      let stopped = false;
      let consumer: KafkaConsumerLike | undefined;
      let retryTimer: NodeJS.Timeout | undefined;
      const timers = new Set<NodeJS.Timeout>();
      const later = (fn: () => void, ms: number): NodeJS.Timeout => {
        const t = setTimeout(() => {
          timers.delete(t);
          fn();
        }, ms);
        timers.add(t);
        return t;
      };

      const eachMessage = async (p: EachMessagePayload): Promise<void> => {
        const { topic, partition, message } = p;
        try {
          if (message.value !== null) {
            const ts = Number(message.timestamp);
            const receivedAt = (
              Number.isFinite(ts) ? new Date(ts) : new Date()
            ).toISOString();
            await emit(message.value.toString("utf8"), { receivedAt });
          }
          // Tombstones (null value) are skipped but committed.
          await consumer?.commitOffsets([
            {
              topic,
              partition,
              offset: (BigInt(message.offset) + 1n).toString(),
            },
          ]);
        } catch (e) {
          if (stopped) return;
          ctx.logger?.error(
            `kafka ${topic}[${partition}]@${message.offset} failed, retrying in ${RETRY_DELAY_MS} ms: ${String(e)}`,
          );
          // Never skip: rewind to this message and resume the partition shortly.
          const c = consumer;
          if (!c) return;
          c.pause([{ topic, partitions: [partition] }]);
          c.seek({ topic, partition, offset: message.offset });
          later(() => {
            try {
              c.resume([{ topic, partitions: [partition] }]);
            } catch (err) {
              ctx.logger?.error(`kafka resume failed: ${String(err)}`);
            }
          }, RETRY_DELAY_MS);
        }
      };

      const attempt = async (): Promise<void> => {
        if (stopped) return;
        const c = factory(config, ctx);
        consumer = c;
        try {
          c.on(c.events.CRASH, (e) => {
            const ev = e as { payload?: { error?: unknown; restart?: boolean } };
            ctx.logger?.error(
              `kafka consumer crashed (restart: ${String(ev.payload?.restart)}): ${String(ev.payload?.error)}`,
            );
            if (ev.payload?.restart === false && !stopped) reconnect(c);
          });
          await c.connect();
          if (stopped) return void (await c.disconnect().catch(() => undefined));
          await c.subscribe({
            topic: config.topic,
            fromBeginning: config.fromBeginning,
          });
          if (stopped) return void (await c.disconnect().catch(() => undefined));
          await c.run({ autoCommit: false, eachMessage });
          if (stopped) return void (await c.disconnect().catch(() => undefined));
          ctx.logger?.info(
            `kafka source ${ctx.sourceId}: consuming ${config.topic} as group ${config.groupId}`,
          );
        } catch (e) {
          if (stopped) {
            void c.disconnect().catch(() => undefined);
            return;
          }
          ctx.logger?.error(`kafka start failed: ${String(e)}`);
          reconnect(c);
        }
      };

      const reconnect = (old: KafkaConsumerLike): void => {
        if (stopped || retryTimer) return;
        void old.disconnect().catch(() => undefined);
        retryTimer = later(() => {
          retryTimer = undefined;
          void attempt().catch((e: unknown) =>
            ctx.logger?.error(`kafka reconnect failed: ${String(e)}`),
          );
        }, CONNECT_RETRY_MS);
      };

      // Never block the caller (the runner starts sources sequentially): connect in the background.
      void attempt().catch((e: unknown) =>
        ctx.logger?.error(`kafka start failed: ${String(e)}`),
      );

      const onAbort = () => void handle.stop();
      ctx.signal?.addEventListener("abort", onAbort, { once: true });
      const handle = {
        async stop() {
          if (stopped) return;
          stopped = true;
          ctx.signal?.removeEventListener("abort", onAbort);
          for (const t of timers) clearTimeout(t);
          timers.clear();
          try {
            await consumer?.disconnect();
          } catch (e) {
            ctx.logger?.warn(`kafka disconnect failed: ${String(e)}`);
          }
        },
      };
      return handle;
    },
  };
}

export const kafkaPlugin = createKafkaPlugin();
