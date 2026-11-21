/**
 * Redis names shared between pipeline stages. All keys are prefixed `alerting:`.
 * Streams use consumer groups so several worker instances share the load.
 */
import type { Event } from "./types/event.js";

export const PREFIX = "alerting:";

/** Stream. ingest (http/file_tail/redis_stream sources) -> parse worker. Entry field `data` = JSON RawMessage. */
export const STREAM_RAW_EVENTS = `${PREFIX}events:raw`;
/** Stream. parse worker -> rule engine. Entry field `data` = JSON {@link Event} (stored and normalised). */
export const STREAM_EVENTS = `${PREFIX}events`;
/** Stream. rule engine -> delivery fan-out. Entry field `data` = JSON {@link AlertEvent}. */
export const STREAM_ALERTS = `${PREFIX}alerts`;
/** List. fan-out -> channel workers (BRPOPLPUSH-style, durable). Items = JSON Notification. */
export const QUEUE_DELIVERY = `${PREFIX}delivery:queue`;
/** Processing list paired with the delivery queue for crash recovery. Items = JSON Notification. */
export const QUEUE_DELIVERY_PROCESSING = `${PREFIX}delivery:processing`;
/** Sorted set. channel worker (failed, retryable) -> retry mover. Score = epoch ms due, member = JSON Notification. */
export const ZSET_DELIVERY_RETRY = `${PREFIX}delivery:retry`;
/** List. channel worker (retries exhausted) -> API/UI dead letters page. Items = JSON DeadLetter. */
export const LIST_DEAD_LETTERS = `${PREFIX}delivery:dead`;
/** Pub/sub. API config writers / YAML watcher -> all engine, ingest and worker instances. Message = JSON ConfigChange. */
export const CHANNEL_CONFIG_CHANGE = `${PREFIX}config:changed`;
/** Pub/sub. rule engine, delivery, API -> API SSE endpoint -> browsers. Message = JSON UiPush. */
export const CHANNEL_UI_PUSH = `${PREFIX}ui:push`;
/** Key prefix. rule engine dedup state: `${KEY_DEDUP_PREFIX}{ruleId}:{dedupKey}` -> open alert id. */
export const KEY_DEDUP_PREFIX = `${PREFIX}dedup:`;
/** Key prefix. delivery throttle counters: `${KEY_THROTTLE_PREFIX}{recipientId}:{channel}` -> count (TTL = window). */
export const KEY_THROTTLE_PREFIX = `${PREFIX}throttle:`;
/** Key prefix. throttle digest buffers: `${KEY_DIGEST_PREFIX}{recipientId}:{channel}` -> list of Notification. */
export const KEY_DIGEST_PREFIX = `${PREFIX}digest:`;
/** Key. recent stored events for "test against recent events" (capped list of Event JSON). */
export const LIST_RECENT_EVENTS = `${PREFIX}events:recent`;

/** Consumer groups (one per stage reading a stream). */
export const GROUP_PARSE = "parse";
export const GROUP_ENGINE = "engine";
export const GROUP_FANOUT = "fanout";

export function dedupKey(ruleId: string, dedupKeyValue: string): string {
  return `${KEY_DEDUP_PREFIX}${ruleId}:${dedupKeyValue}`;
}
export function throttleKey(recipientId: string, channel: string): string {
  return `${KEY_THROTTLE_PREFIX}${recipientId}:${channel}`;
}
export function digestKey(recipientId: string, channel: string): string {
  return `${KEY_DIGEST_PREFIX}${recipientId}:${channel}`;
}

/** Payload of STREAM_RAW_EVENTS. */
export interface RawMessage {
  sourceId: string;
  receivedAt: string;
  /** Unparsed text of one message. */
  raw: string;
}

/** Payload of STREAM_ALERTS: what changed on an alert and whom to notify. */
export interface AlertEvent {
  alertId: string;
  kind: "created" | "updated" | "severity_increased" | "acknowledged" | "resolved";
  eventId: string;
  at: string;
}

/** Payload of CHANNEL_CONFIG_CHANGE. */
export interface ConfigChange {
  kind: "source" | "schema" | "rule" | "person" | "group" | "preference" | "runbook";
  id: string;
  op: "upsert" | "delete";
}

/** Payload of CHANNEL_UI_PUSH (relayed over SSE). */
export type UiPush =
  | { type: "alert"; alertId: string; kind: AlertEvent["kind"] }
  | { type: "event"; event: Event }
  | { type: "dead_letter"; count: number };
