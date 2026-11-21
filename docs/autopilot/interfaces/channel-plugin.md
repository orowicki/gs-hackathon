# Delivery: channel plugins and queue (`@alerting/delivery`)

Users: the rule engine / fan-out calls `queue.enqueue(...)`; the API serves `listDeadLetters` / `retryDeadLetter` / `channelStatus` and relays `CHANNEL_UI_PUSH` over SSE.

## Channel interface

```ts
interface Channel { id: ChannelId; send(n: QueuedNotification): Promise<DeliveryResult> }
registerChannel(channel)            // default registry; or `new ChannelRegistry()` and pass `registry` to the queue
```

`DeliveryResult` is `{status:"delivered"}` or `{status:"failed", retryable, error}`. An unregistered channel id is a non-retryable failure (dead letter); a thrown error is treated as retryable.

## Queue payload

`QueuedNotification = Notification & { approveStepIndex?: number }` (JSON). `approveStepIndex` (delivery-local, not in shared) makes ntfy show an "Approve" action for that runbook step.

## Redis flow

`enqueue` LPUSH `alerting:delivery:queue` -> worker RPOPLPUSH to `alerting:delivery:processing` -> send -> LREM from processing.
Failed and retryable with `attempt < maxAttempts` (default 5): ZADD `alerting:delivery:retry` (score = now + backoff, `attempt` incremented, `nextAttemptAt` set). A mover loop ZRANGEBYSCORE due members, ZREM, and LPUSH back to the queue only if ZREM returned 1.
Exhausted or non-retryable: LPUSH `alerting:delivery:dead` a `DeadLetter {id, notification, error, failedAt}` and publish `{type:"dead_letter", count}` on `alerting:ui:push`.
On `start()` leftover processing items are moved back to the queue (assumes one worker process). `stop()` waits for in-flight sends.
`retryDeadLetter(id)` removes the dead letter, resets `attempt` to 0, enqueues, returns the Notification or null.

Backoff: `baseMs * 2^(attempt-1)`, defaults base 1000 ms, cap 60 000 ms, optional `jitter` (0..1 fraction subtracted). Options: `maxAttempts`, `concurrency` (1..4), `pollMs` (default 50).

## UI push

The `ui` channel publishes `{ type: "notification", notification }` on `alerting:ui:push` (delivery-local addition to `UiPush`).

## ntfy mapping

`createNtfyChannel({ baseUrl, publicUrl, topicFor? })` POSTs JSON `{topic,title,message,priority,click,actions,tags}` to the server root (5 s timeout). Topic default `alerting-${recipientId}`.

| severity | priority |
|---|---|
| critical | 5 |
| error | 4 |
| warning | 3 |
| info | 2 |

`click` = `clickUrl` (prefixed with `publicUrl` if relative). Actions (http, POST): "Acknowledge" -> `${publicUrl}/api/alerts/{alertId}/ack`; "Approve" -> `${publicUrl}/api/alerts/{alertId}/runbook-steps/{approveStepIndex}/approve` (only if `approveStepIndex` is set). With `runbookUrl`, the message gets "Runbook: <url>" and a `view` action.
Network error, 5xx, 429 -> retryable; other non-2xx -> non-retryable.

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
