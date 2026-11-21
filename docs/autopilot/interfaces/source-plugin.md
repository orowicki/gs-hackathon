# Source plugin and parser interfaces (`@alerting/ingest`)

## Parser

```ts
type Parser = (input: string | JsonObject, config: ParserConfig) => JsonObject;
```

Never throws. Anything unreadable returns `{ raw: "<text>" }`. Trailing `\r\n` is stripped.
`parse(input, config)` dispatches on `config.type` through the `PARSERS` registry
(`json`, `logfmt`, `regex`, `raw`); `registerParser(name, parser)` adds more.

- json: plain object only (array, scalar, invalid -> fallback). Object input is returned as-is.
- logfmt: `k=v`, `k="a \"b\""`, bare `k` -> `true`. Values stay strings (number normalisation is #12).
- regex: `config.pattern` with named groups; undefined groups omitted; no match or bad pattern -> fallback.
- raw: always `{ raw }`.

## SourcePlugin

```ts
type Emit = (raw: string | JsonObject, meta?: { receivedAt?: string }) => Promise<void>;
interface SourcePlugin<C = unknown> {
  type: SourceType | string;
  configSchema: JsonSchemaObject; // JSON Schema 2020-12, drives the UI form
  start(config: C, emit: Emit, ctx: SourceContext): Promise<SourceHandle>; // handle.stop()
}
```

Registry: `registerSourcePlugin`, `getSourcePlugin`, `listSourcePlugins`. Built-in config schemas:
`HTTP_CONFIG_SCHEMA`, `FILE_TAIL_CONFIG_SCHEMA`, `REDIS_STREAM_CONFIG_SCHEMA`, plus `PARSER_CONFIG_SCHEMA`.

## Flow

plugin `emit` -> `XADD STREAM_RAW_EVENTS` (`RawMessage {sourceId, receivedAt, raw}`) -> parse worker
(consumer group `parse`) -> `parse(raw, source.parser)` -> Postgres `events` row + `XADD STREAM_EVENTS`
(`Event`, `schemaId` null until schema mapping #12).

## Example

```ts
const heartbeat: SourcePlugin<{ everyMs: number }> = {
  type: "heartbeat",
  configSchema: { type: "object", properties: { everyMs: { type: "integer" } }, required: ["everyMs"] },
  async start(config, emit, ctx) {
    const t = setInterval(() => {
      emit(`beat source=${ctx.sourceId}`).catch((e) => ctx.logger?.error(String(e)));
    }, config.everyMs);
    return { stop: async () => clearInterval(t) };
  },
};
registerSourcePlugin(heartbeat);
```

## Used by

- Sources page: generates the config form from `configSchema`; `POST /api/sources/test` calls `parse`.
- #12 schema mapping hooks into the parse worker after `parse`.

## Delivery semantics and failures

- Parse worker is at-least-once. Redelivery (crash after `XADD STREAM_EVENTS` but before `XACK`, XAUTOCLAIM takeover)
  may duplicate entries on `STREAM_EVENTS`. The event id is deterministic (derived from the raw stream entry id), so
  consumers must dedup by `Event.id`. The Postgres insert is idempotent (`ON CONFLICT (id) DO NOTHING`).
- NUL (`\u0000`) is stripped from strings/keys in `raw`/`parsed`/`common` before insert (jsonb rejects it).
- A batch insert that fails with a pg data error (SQLSTATE class 22 or 23) is retried per row; a row that still fails
  is logged, pushed to the capped Redis list `alerting:ingest:failed` (1000 entries), acked and dropped. Other errors
  (connection, etc.) leave the entries pending and the worker retries.
- XAUTOCLAIM runs at start and every 15 s (min idle 30 s), following the returned cursor until `0`.
- `redis_stream` source: consumer name `INGEST_CONSUMER` or `ingest-<hostname>` (stable across restarts). A trimmed
  pending entry (`[id, null]`) is acked and skipped. If `emit` throws, the source re-reads its pending list from id `0`
  after 500 ms.
- `kafka` source (kafkajs): config `brokers` (comma-separated), `topic`, `groupId` (default `alerting`), `fromBeginning`
  (default false). Auto-commit is off; an offset is committed after `emit` resolves (null-value tombstones are skipped
  and committed). If `emit` throws, nothing is committed, the partition is paused and rewound to that message and
  resumed after 500 ms. Broker outages: kafkajs retries and `restartOnFailure` always restarts the consumer; a failed
  first connect is retried every 2 s without failing `start`. Config is validated in `start` (the API does not validate
  it against `configSchema`).
- `file_tail`: rotation is detected via inode/device change (or size shrink) and the offset resets to 0. A line whose
  `emit` failed is not skipped: the file is retried next tick. `stop()` awaits any in-flight scan.
- `POST /ingest/:sourceId`: 404 for unknown source before reading the body, 413 early on `Content-Length` above 10 MB
  (and on streamed overflow, the request is destroyed), server `requestTimeout` 30 s. If `emit` fails midway the route
  responds 500 `{accepted: n, error: "emit failed"}` where `n` messages were already published; clients should resend
  only the rest.

## Runtime

Ingest runs inside the API process (`packages/api/src/main.ts` calls `startIngestService` when `DATABASE_URL` and
`REDIS_URL` are set; otherwise it logs and skips). Reason: `handleHttpIngest` uses an in-process registry, so the
http plugin must live with `POST /ingest/:sourceId` (202 `{accepted}`, 404 unknown source, 400 empty, 413 over 10 MB).
`startIngestService` runs the migrations (config + `events` table), the sources runner (`startIngest`: starts enabled
sources, restarts on config change) and the parse worker (group `parse`, `XREADGROUP`, batch insert into `events`,
then `XADD STREAM_EVENTS` + `LPUSH/LTRIM LIST_RECENT_EVENTS`, then `XACK`). Event ids derive from the stream entry
id, so redelivery does not duplicate Postgres rows. `mapEvent` is the hook for schema mapping (#12).

Deployment shape: the api process runs sources (including http) plus the parse worker. Standalone
(`npm start -w @alerting/ingest`) starts only the parse worker by default; `INGEST_RUN_SOURCES=1` also runs the
non-http sources there (never enable it while the api process also runs them, or sources double-run). Several parse
workers can share the `parse` group (set a distinct `WORKER_CONSUMER` each).
