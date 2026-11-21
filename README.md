# Alerting service

TypeScript monorepo: `packages/api` (HTTP API with `/health`) and `packages/shared`, run with Postgres, Redis and ntfy via Docker Compose.

## Docs

- [Architecture](docs/architecture.md)
- [Config formats](docs/config-formats.md)
- [Extending](docs/extending.md)
- [Performance](docs/performance.md)

## Requirements

- Docker (with Compose)
- Node 22.6+ (the seed and demo scripts run on the host with `--experimental-strip-types`)
- [just](https://github.com/casey/just)

## Quick start

```sh
just up      # build, start the stack, wait for /health, seed demo data
just demo    # send a realistic mix of events for 60 s
just down
```

- `just up`: the first build takes roughly 1-2 minutes (image build and dependency install); later starts reuse the cache. It waits up to 120 s for `/health`, checks the host Node version, runs `npm ci` if `node_modules/yaml` is missing, then seeds. Seeding only creates what is missing and never overwrites, so edits survive a restart and a second run changes nothing (it prints `seed: created N, kept M`).
- Seeded: the people (anna, ewa, julia, marek, tomasz), groups (pricing-team, rates-desk, settlements-oncall), the three Appendix A schemas and four rules, the three Appendix B runbooks (all from `config/`), four demo sources (`demo-http`, `demo-logs` tailing `/tmp/demo-logs/*.log` in the app container, `demo-stream` on Redis stream `demo:events`, `demo-kafka` on Kafka topic `demo.events`) and Anna's preference (critical to ui + ntfy, quiet hours 20:00-08:00 Europe/Warsaw, ui only).
- Open <http://localhost:3000> and pick a profile.
- `just demo` first sends a fixed showcase (about 19 events, a few seconds), then about 2 random events/s until the 60 s are up (the showcase counts towards them), round-robin over HTTP (`POST /ingest/demo-http`), file tail, Redis stream and Kafka (the demo prints a warning and skips Kafka if the broker is not reachable). The showcase alone gives a feed with all four severities (critical, error, warning, info, at least 2 open alerts each), sources `payments-api`, `pricing-engine-emea`, `pricing-engine-apac`, `pricing-engine-staging`, `order-settlement` and `trade-gateway`, environments `prod` and `staging`, alerts that repeat (dedup count 3 for the payments critical) and alerts that resolve (a pricing latency and a staging payments critical). Every seeded rule fires (info comes from large rejected rates trades, staging from Anna's and Team Pricing's rules, which do not check the environment). The random part adds settlement failures, latency, rejected trades, resolved metrics, repeats and the odd unparseable line.
- Options: `just demo --once` (one of each type through each source), `just demo --burst` (about 30 fresh random events as fast as possible, a few seconds, no showcase, no resolves; events for the same service still count as repeats), `just demo --no-showcase` (random events only), `just demo --rate 5 --duration 30`, `just demo --count 20` (showcase, then 20 random events). Sends through file_tail and Redis use `docker compose exec` and cost roughly 0.3-1 s each, so the real rate may be lower than requested. It prints per-source counts at the end; run it from the repo root.
- `just longtest`: 15 minutes of the same traffic (showcase, then random events), and from 10 s on about 30% of the random events are in a schema no seeded schema recognises: a stale market-data feed, `{"eventName": "md.feed.stale", "feed": "fx-spot-eu", "instrument": "EURUSD", "staleForSec": 45, "level": "SEV2", "venue": "LDN", "env": "prod", "detectedAt": <epoch s>}`. Those events are stored but match no schema, so they are the ones to map live: add a schema with `match: eventName = md.feed.stale` (severity from `level` with a value map SEV1 → critical, SEV2 → error, SEV3 → warning; `occurredAt` from `detectedAt`), and the next ones are recognised. Flags as for `just demo`, e.g. `just longtest --unknown-share 0.5` or `just longtest --unknown-after 30`; `--duration` overrides the 15 minutes.
- Filters to try in the alerts list (`alert.*` reads the alert itself; bare names such as `type` or `payload.desk` read the original event). The counts below are for the showcase alone: the random phase adds more alerts on top, so counts grow, but the showcase alerts keep their state (random events never reuse their dedup keys):
  1. `alert.severity = critical`: 4 showcase alerts (payments-api prod, pricing-engine-apac, an order-settlement workflow, and the resolved staging payments-api critical).
  2. `alert.source = payments-api`: the prod critical (repeated, count 3) and the staging critical (resolved).
  3. `alert.environment = staging`: the open pricing-engine-staging warning and the resolved staging payments critical.
  4. `alert.status != resolved`: everything still open; hides the resolved pricing-engine-emea latency and the resolved staging payments critical.
  5. `alert.count > 1`: the repeated alerts (payments-api critical, pricing-engine-apac latency, the confirm-settlement failure).
  Combine them, e.g. `alert.severity >= warning AND alert.environment = prod AND alert.status != resolved`.
- Notifications on ntfy: <http://localhost:8080>, topics `alerting-<person>` (e.g. `alerting-anna`; see `ntfyTopic` in `config/people/`).

### Kafka source

`just up` also starts a single-node Redpanda broker (Kafka API, no ZooKeeper): `redpanda:9092` inside the compose network, `localhost:19092` from the host. A source of type `kafka` consumes one topic as a consumer group (offsets are committed after an event is accepted, so delivery is at-least-once):

```json
{ "id": "my-kafka", "name": "My Kafka", "enabled": true, "parser": { "type": "json" },
  "type": "kafka", "config": { "brokers": "redpanda:9092", "topic": "demo.events", "groupId": "alerting" } }
```

Send a test message to the seeded `demo-kafka` source:

```sh
echo '{"alertname":"HighErrorRate","labels":{"service":"payments-api","region":"eu-west","severity":"critical"},"annotations":{"summary":"Error rate 27%"},"startsAt":"2026-11-21T10:00:00Z","status":"firing"}' \
  | docker compose exec -T redpanda rpk topic produce demo.events
```

More in [docs/config-formats.md](docs/config-formats.md).

## What is mocked

- `demo-service` stands in for the real systems that runbook HTTP actions call.
- ntfy is a local container, not a hosted service.
- No authentication: the UI has a profile picker instead of a login.
- Events are generated by `just demo`; there are no real upstream systems.

## Extending

Step-by-step guides for a new source type, parser, delivery channel, runbook action and API route are in [docs/extending.md](docs/extending.md). New schemas, rules and sources can also be added as YAML.

YAML files in `config/` are loaded by the seed on `just up` (only if missing) and then watched live; formats are in [docs/config-formats.md](docs/config-formats.md). To change seeded demo sources or Anna's preference, edit `scripts/seed/seed.ts`.

## Let Claude configure it

The service is fully configurable through its HTTP API, described by an OpenAPI document at <http://localhost:3000/api/openapi.json>. Give that URL to Claude (or any LLM agent that can make HTTP calls) with a prompt such as:

> Using the API described at http://localhost:3000/api/openapi.json, add an http source `billing`, a schema for events shaped like `{"invoice": {"id": "INV-1", "status": "failed", "amount": 120}}`, and a rule that notifies the pricing-team group on severity >= error. Then send a sample event to `/ingest/billing` and check that an alert appears.

Existing entities can be inspected with `GET /api/{sources,schemas,rules,people,groups,runbooks}`.

### MCP server

`packages/mcp` is a stdio MCP server that wraps the HTTP API. Run it with `just mcp`. It reads the API address from `ALERTING_API_URL` (default `http://localhost:3000`).

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

Run `npm run build -w @alerting/mcp` once first, so `dist/main.js` exists.

Tools:

- `list_sources`, `get_source`, `create_source`, `update_source`, `delete_source`
- `list_schemas`, `get_schema`, `create_schema`, `update_schema`, `delete_schema`
- `list_rules`, `get_rule`, `create_rule`, `update_rule`, `delete_rule`
- `validate_filter`: check a filter expression
- `list_recent_events`: newest events first
- `list_alerts`: with `filter`, `state`, `limit`, `before`, `sort`, `order`, `offset`
- `acknowledge_alert`, `resolve_alert`

API errors come back as tool errors with the API's message.

## Configuration

All variables have defaults, so the stack runs without any configuration. Override them with a `.env` file in the repo root (gitignored); compose reads it automatically.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Port the API listens on (api defaults to 3000 outside compose) |
| `DATABASE_URL` | `postgres://alerting:alerting@postgres:5432/alerting` | Postgres connection string |
| `REDIS_URL` | `redis://redis:6379` | Redis connection string |
| `NTFY_URL` | `http://ntfy:80` | Base URL of the ntfy server (host access: `http://localhost:8080`) |
| `CONFIG_DIR` | `./config` (`/app/config` in compose) | Directory of YAML config (sources, schemas, rules, people, groups, runbooks), watched live. Files are loaded on start only if the entity is missing, later file edits overwrite, deleting a file deletes the entity |
| `POSTGRES_USER` | `alerting` | Postgres user created on first start |
| `POSTGRES_PASSWORD` | `alerting` | Postgres password |
| `POSTGRES_DB` | `alerting` | Postgres database name |
| `API_URL` | `http://localhost:3000` | Base URL used by the seed and demo scripts (host side) |
| `DEMO_LOG_FILE` | unset | `just demo`: append file_tail lines to this local file instead of `/tmp/demo-logs/demo.log` in the app container |
| `DEMO_KAFKA_BROKERS` | `localhost:19092` | `just demo`: Kafka brokers to produce to |
| `SEED_KAFKA_BROKERS` | `redpanda:9092` | `just up` seed: brokers stored in the `demo-kafka` source (as seen from the containers) |
| `KAFKA_BROKERS` | `localhost:19092` | Kafka integration test only |
| `DEMO_REDIS_URL` | unset | `just demo`: XADD to this Redis directly instead of `docker compose exec redis` (Redis is not exposed to the host by default) |
| `DEMO_RATE` / `DEMO_DURATION` / `DEMO_COUNT` | `2` / `60` / unset | Events per second, duration in seconds, event count (same as `--rate`, `--duration`, `--count`) |

## Performance

Load test at 5000 ev/s for 60 s (local mode, current code): both configurations are overloaded. Sustainable throughput is 519.3 ev/s with 1 worker and 930.4 ev/s with 2 workers (about 1.8x); backlog at end 237354 and 187821 events, 0 lost. Latency is dominated by queueing (e2e p50 63843 ms and 66533 ms), so the targets (p50 < 50 ms, p99 < 250 ms) are not met.
Before the engine dedup merge (#61) 2 workers sustained 5000 ev/s with p50 9 ms and p99 531 ms (medians of 3 windows); the regression is in the engine, outside #31.
Details, caveats and how to re-run (`just loadtest`): [docs/performance.md](docs/performance.md). Raw results: [1 worker](results/loadtest-2026-11-21.json), [2 workers](results/loadtest-2026-11-21-workers2.json).
