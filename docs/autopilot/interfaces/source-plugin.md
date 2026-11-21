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
