# Delivery: channel plugins and queue (`@alerting/delivery`)

Users: the rule engine / fan-out calls `queue.enqueue(...)`; the API serves `listDeadLetters` / `retryDeadLetter` / `channelStatus` and relays `CHANNEL_UI_PUSH` over SSE.

## Channel interface

```ts
interface Channel { id: ChannelId; send(n: QueuedNotification): Promise<DeliveryResult> }
registerChannel(channel)            // default registry; or `new ChannelRegistry()` and pass `registry` to the queue
```

`DeliveryResult` is `{status:"delivered"}` or `{status:"failed", retryable, error}`; channels may also return the delivery-local `ChannelResult` variant `{status:"failed", retryable:true, unavailable:true, error}` for an unreachable channel. An unregistered channel id is a non-retryable failure (dead letter); a thrown error is treated as retryable.

## Queue payload

`QueuedNotification = Notification & { approveStepIndex?: number }` (JSON). `approveStepIndex` (delivery-local, not in shared) makes ntfy show an "Approve" action for that runbook step.

## Redis flow

`enqueue` LPUSH `alerting:delivery:queue` -> worker RPOPLPUSH to its own processing list `alerting:delivery:processing:{workerId}` -> send -> one MULTI (retry ZADD or dead-letter LPUSH, plus LREM from processing).
Failure classes:
- Channel unavailable (`ChannelResult` with `unavailable: true`; ntfy returns it for network errors/timeouts, 5xx, 429): ZADD to `alerting:delivery:retry` with backoff (cap 60 s), does NOT consume `maxAttempts`; dead-lettered only after `maxOutageMs` (default 24 h) since the first such failure. So a ntfy outage piles notifications up and they are delivered after it recovers, with production defaults.
- Other retryable failures retry until `attempt >= maxAttempts` (default 5), then dead-letter. Non-retryable: dead-letter at once.
Dead letter: LPUSH `alerting:delivery:dead` a `DeadLetter {id, notification, error, failedAt}`, then publish `{type:"dead_letter", count}` on `alerting:ui:push` (best effort; a failed publish does not abort the step).
Retry mover: ZRANGEBYSCORE due members, then MULTI LPUSH queue + ZREM; if ZREM removed nothing (another instance won) the pushed copy is taken back. A member is never lost or moved twice.
`retryDeadLetter(id)`: one MULTI of LPUSH queue + LREM dead letter (attempt reset to 0).
Unparseable queue payloads go to the dead-letter list as `corrupt-<ts>-<n>` ("unparseable payload", raw text in the placeholder title); corrupt dead-letter entries are skipped by `listDeadLetters`/`channelStatus`.
If a Redis error interrupts a step, the worker moves its in-flight item back to the queue (at-least-once).

### Multiple workers (leases)

Each `start()` picks a random `workerId`, registers it in set `alerting:delivery:processing:workers` and keeps heartbeat key `alerting:delivery:processing:{workerId}:alive` (TTL `leaseMs` 15 s, refreshed every `heartbeatMs` 5 s). A reaper (on start and every `heartbeatMs`) moves items from the processing lists of workers whose heartbeat expired back to the queue with RPOPLPUSH (atomic per item) and removes them from the set. Items left in the legacy shared `alerting:delivery:processing` list are migrated to the queue on start. `stop()` waits for in-flight sends, then deregisters. `channelStatus` pending counts cover queue, retry set, all worker processing lists and the legacy list.

Backoff: `baseMs * 2^(n-1)`, defaults base 1000 ms, cap 60 000 ms, optional `jitter` (0..1). Options: `maxAttempts`, `maxOutageMs`, `concurrency` (1..4), `pollMs` (default 50; idle polling backs off to 500 ms and resets on work), `heartbeatMs`, `leaseMs`.

## UI push

The `ui` channel publishes `{ type: "notification", notification }` on `alerting:ui:push` (delivery-local addition to `UiPush`). The `ui` channel is best-effort live push: Redis pub/sub reaches only currently connected SSE clients (the feed reloads alerts from the API on connect). It is not covered by the no-loss guarantee, which applies to external channels such as ntfy.

## ntfy mapping

`createNtfyChannel({ baseUrl, publicUrl, topicFor? })` POSTs JSON `{topic,title,message,priority,click,actions,tags}` to the server root (5 s timeout). Topic default `alerting-${recipientId}`.

| severity | priority |
|---|---|
| critical | 5 |
| error | 4 |
| warning | 3 |
| info | 2 |

`click` = `clickUrl` (prefixed with `publicUrl` if relative). Actions (http, POST): "Acknowledge" -> `${publicUrl}/api/alerts/{alertId}/ack`; "Approve" -> `${publicUrl}/api/alerts/{alertId}/runbook-steps/{approveStepIndex}/approve` (only if `approveStepIndex` is a non-negative integer; `alertId` is URL-encoded; `click`/`view` URLs other than http/https are omitted). With `runbookUrl`, the message gets "Runbook: <url>" and a `view` action.
Network error, 5xx, 429 -> retryable and `unavailable`; other non-2xx -> non-retryable.

## Adding a channel (e.g. SMS)

```ts
registerChannel({ id: "sms", async send(n) {
  const r = await fetch(SMS_URL, { method: "POST", body: JSON.stringify({ to: n.recipientId, text: n.title }) });
  return r.ok ? { status: "delivered" } : { status: "failed", retryable: r.status >= 500, error: `HTTP ${r.status}` };
}});
```

Then enqueue notifications with `channel: "sms"`.

## Tests

`npm test` uses ioredis-mock, or real Redis if `REDIS_URL` is set. The outage test stops a stub ntfy server, enqueues 20 notifications, restarts it and checks all arrive. With `NTFY_E2E=1 NTFY_URL=http://localhost:8080` a real-ntfy test runs (pair it with `docker compose stop ntfy` / `start ntfy`).
