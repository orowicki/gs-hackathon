# Reference

Details for running demos and wiring things up. The overview is in the [README](../README.md).

## Demo data and traffic

- **Seeded by `just up`** (from `config/` and `scripts/seed/seed.ts`): people (anna, ewa, julia, marek, piotr, tomasz), groups (counterparty-support, pricing-team, rates-desk, settlements-oncall), three schemas, four rules, the runbooks, four demo sources (`demo-http`, `demo-logs` tailing `/tmp/demo-logs/*.log` in the app container, `demo-stream` on Redis stream `demo:events`, `demo-kafka` on Kafka topic `demo.events`) and Anna's preference (critical to UI + ntfy, quiet hours 20:00-08:00 Europe/Warsaw, UI only).
- **`just demo`** first sends a fixed showcase (about 19 events, a few seconds), then about 2 random events/s until 60 s are up, round-robin over HTTP, file tail, Redis stream and Kafka (Kafka is skipped with a warning if the broker isn't reachable). The showcase alone gives all four severities, several sources (`payments-api`, `pricing-engine-emea`, `pricing-engine-apac`, `pricing-engine-staging`, `order-settlement`, `trade-gateway`), `prod` and `staging`, repeating alerts and alerts that resolve.
- **Options**: `just demo --once` (one of each type through each source), `--burst` (about 30 random events as fast as possible), `--no-showcase`, `--rate 5 --duration 30`, `--count 20`. Sends through file tail and Redis cost 0.3-1 s each, so the real rate may be lower than requested.
- **`just longtest`**: 15 minutes of traffic; from 10 s on about 30% of events are a stale market-data feed no schema recognises (`{"eventName": "md.feed.stale", "level": "SEV2", "detectedAt": <epoch s>, ...}`). Map it live by adding a schema with `match: eventName = md.feed.stale` (severity from `level`: SEV1 → critical, SEV2 → error, SEV3 → warning; time from `detectedAt`). Flags: `--unknown-share 0.5`, `--unknown-after 30`, `--duration`.
- **Filters to try** on the showcase: `alert.severity = critical` (4 alerts), `alert.source = payments-api` (prod critical ×3 and a resolved staging critical), `alert.environment = staging`, `alert.status != resolved`, `alert.count > 1`, or combined: `alert.severity >= warning AND alert.environment = prod AND alert.status != resolved`.

## Kafka source

`just up` starts a single-node Redpanda broker (Kafka API): `redpanda:9092` inside the compose network, `localhost:19092` from the host. A `kafka` source consumes one topic as a consumer group (offsets are committed after an event is accepted, so delivery is at-least-once):

```json
{ "id": "my-kafka", "name": "My Kafka", "enabled": true, "parser": { "type": "json" },
  "type": "kafka", "config": { "brokers": "redpanda:9092", "topic": "demo.events", "groupId": "alerting" } }
```

Send a test message to the seeded `demo-kafka` source:

```sh
echo '{"alertname":"HighErrorRate","labels":{"service":"payments-api","region":"eu-west","severity":"critical"},"annotations":{"summary":"Error rate 27%"},"startsAt":"2026-11-21T10:00:00Z","status":"firing"}' \
  | docker compose exec -T redpanda rpk topic produce demo.events
```

## MCP server

`packages/mcp` is a stdio MCP server that wraps the HTTP API. Build it once with `npm run build -w @alerting/mcp`, then run it with `just mcp`. It reads the API address from `ALERTING_API_URL` (default `http://localhost:3000`).

Claude Code:

```sh
claude mcp add alerting -e ALERTING_API_URL=http://localhost:3000 -- node /path/to/repo/packages/mcp/dist/main.js
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "alerting": {
      "command": "node",
      "args": ["/path/to/repo/packages/mcp/dist/main.js"],
      "env": { "ALERTING_API_URL": "http://localhost:3000" }
    }
  }
}
```

Tools: `list_/get_/create_/update_/delete_` for sources, schemas and rules; `validate_filter`; `list_recent_events`; `list_alerts` (with `filter`, `state`, `limit`, `before`, `sort`, `order`, `offset`); `acknowledge_alert`, `resolve_alert`. API errors come back as tool errors with the API's message.

## Environment variables

Everything has a default, so the stack runs with no configuration. To override, put a `.env` file in the repo root (gitignored); Compose reads it automatically.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Port the API listens on |
| `DATABASE_URL` | `postgres://alerting:alerting@postgres:5432/alerting` | Postgres connection string |
| `REDIS_URL` | `redis://redis:6379` | Redis connection string |
| `NTFY_URL` | `http://ntfy:80` | Base URL of the ntfy server (host access: `http://localhost:8080`) |
| `CONFIG_DIR` | `./config` (`/app/config` in compose) | YAML config directory, watched live. Files load on start only if the entity is missing; later edits overwrite; deleting a file deletes the entity |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | `alerting` | Postgres credentials and database created on first start |
| `WORKERS` | `1` | Number of worker containers (ingest, engine, runbooks) |
| `API_URL` | `http://localhost:3000` | Base URL used by the seed and demo scripts |
| `DEMO_LOG_FILE` | unset | `just demo`: append file-tail lines to this local file instead of the app container |
| `DEMO_KAFKA_BROKERS` | `localhost:19092` | `just demo`: Kafka brokers to produce to |
| `SEED_KAFKA_BROKERS` | `redpanda:9092` | Brokers stored in the seeded `demo-kafka` source |
| `KAFKA_BROKERS` | `localhost:19092` | Kafka integration test only |
| `DEMO_REDIS_URL` | unset | `just demo`: XADD to this Redis directly instead of via `docker compose exec` |
| `DEMO_RATE` / `DEMO_DURATION` / `DEMO_COUNT` | `2` / `60` / unset | Same as `--rate`, `--duration`, `--count` |
