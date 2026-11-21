# Redis streams, queues and channels

Source of truth: `packages/shared/src/streams.ts` (each constant has a JSDoc line with producer, consumer, payload). All names start with `alerting:`.

| Name | Kind | Flow |
|---|---|---|
| `STREAM_RAW_EVENTS` | stream | ingest to parse worker (`RawMessage`), group `parse` |
| `STREAM_EVENTS` | stream | parse worker to rule engine (`Event`), group `engine` |
| `STREAM_ALERTS` | stream | rule engine to delivery fan-out (`AlertEvent`), group `fanout` |
| `QUEUE_DELIVERY` (+ `_PROCESSING`) | lists | fan-out to channel workers (`Notification`) |
| `ZSET_DELIVERY_RETRY` | sorted set | failed retryable notifications, score = due epoch ms |
| `LIST_DEAD_LETTERS` | list | exhausted retries (`DeadLetter`), shown in UI |
| `CHANNEL_CONFIG_CHANGE` | pub/sub | config writers to all processes (`ConfigChange`) |
| `CHANNEL_UI_PUSH` | pub/sub | engine/delivery to API SSE (`UiPush`) |
| `KEY_DEDUP_PREFIX`, `KEY_THROTTLE_PREFIX`, `KEY_DIGEST_PREFIX` | key prefixes | use `dedupKey()`, `throttleKey()`, `digestKey()` helpers |
| `LIST_RECENT_EVENTS` | list | capped recent events for "test against recent events" |

Stream entries carry one field, `data`, holding the JSON payload. Example: `XADD alerting:events:raw * data '{"sourceId":"s1","receivedAt":"...","raw":"{...}"}'`.

Who uses it: A produces raw and stored events; B consumes events, produces alerts and runs delivery; C consumes UI push and dead letters via the API.
