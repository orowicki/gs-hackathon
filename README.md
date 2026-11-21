# Alerting service

An alerting service for operations teams. It collects events from your systems, decides which ones matter, turns them into alerts, tells the right people on the channels they prefer, and can run automated runbooks (with human approval where it counts).

- **One feed for everything**: events arrive over HTTP, log files, Redis streams or Kafka, in whatever shape your systems produce.
- **Rules you can read**: "workflow failed in prod → page Settlements on-call on ntfy" is one rule, written in a small filter language.
- **Notifications that respect people**: each person picks channels per severity and quiet hours; repeats are grouped instead of spamming.
- **Runbooks**: written instructions shown next to the alert, or automated steps (call an API, escalate, wait) that can require approval from a named group.
- **Configurable your way**: the web UI, YAML files, the HTTP API, or Claude via MCP.

---

## Contents

- [Install](#install)
- [A five-minute tour](#a-five-minute-tour)
- [How it works](#how-it-works)
- [Using the app](#using-the-app)
- [Who can do what](#who-can-do-what)
- [Configuring without the UI](#configuring-without-the-ui)
- [Troubleshooting](#troubleshooting)
- [Reference](#reference)

---

## Install

### Requirements

| Tool | Version | Why |
| --- | --- | --- |
| [Docker](https://docs.docker.com/get-docker/) with Compose | recent | runs the app and its services (Postgres, Redis, Kafka, ntfy, Mailpit) |
| [Node.js](https://nodejs.org/) | **22.6 or newer** | the seed and demo scripts run on your machine |
| [just](https://github.com/casey/just) | any | short commands for starting, stopping and demoing |

### Start it

```sh
git clone https://github.com/orowicki/gs-hackathon.git
cd gs-hackathon
just up
```

`just up` builds the images, starts the stack, waits until the API is healthy, and loads demo data (people, groups, schemas, rules, runbooks and sources). The first build takes 1-2 minutes; later starts are quick. When it prints `ready: http://localhost:3000` you're set.

Seeding never overwrites anything, so running `just up` again is safe and keeps your edits.

### What's running

| Address | What it is |
| --- | --- |
| <http://localhost:3000> | **The app** (web UI and API) |
| <http://localhost:8080> | ntfy: push notifications. Subscribe to `alerting-<person>`, e.g. `alerting-anna` |
| <http://localhost:8025> | Mailpit: catches every email the app sends (addressed to `<person-id>@alerting.local`) |
| <http://localhost:4100> | Demo service: a stand-in for the real systems that runbooks call |
| `localhost:19092` | Kafka (Redpanda) for Kafka sources |

### Stop it

```sh
just down                 # stop everything, keep the data
docker compose down -v    # stop and wipe all data (next `just up` reseeds)
```

---

## A five-minute tour

1. **Start the stack and send traffic.**
   ```sh
   just up
   just demo      # about 60 s of realistic events
   ```
2. **Sign in.** Open <http://localhost:3000> and pick a person. There are no passwords; this is a demo profile picker. Try **Anna Kowalska** (payments lead, can edit rules).
3. **Watch the alert feed.** Alerts appear live with severity, source and a count when the same problem repeats. Try a filter such as `alert.severity = critical` or `alert.status != resolved`.
4. **Open an alert.** You see the original event, the rule that matched, the runbooks that apply and the full audit history. **Acknowledge** it to tell the team you're on it, then **Resolve** it and say how it was fixed.
5. **Get notified.** Open <http://localhost:8080>, subscribe to `alerting-anna`, and run `just demo` again. Critical alerts reach Anna on her phone or desktop, except during her quiet hours (20:00-08:00 Europe/Warsaw).
6. **Approve a runbook step.** Sign in as **Julia** or **Marek** (Settlements on-call). Automated runbook steps that need a person show up under **Approvals**; approve to run the step or skip it. People outside the step's approvers group can see it but can't decide it.

---

## How it works

```mermaid
flowchart LR
  S[Sources<br/>HTTP · log file · Redis · Kafka] --> E[Events]
  E -->|Schemas recognise<br/>and normalise| N[Normalised events]
  N -->|Rules match| A[Alerts]
  A --> D[Notifications<br/>UI · ntfy · email]
  A --> R[Runbooks<br/>instructions · automated steps]
  R -->|step needs approval| P[Approvals]
```

| Concept | What it is | Example |
| --- | --- | --- |
| **Source** | Where events come in | `POST /ingest/demo-http`, a tailed log file, a Kafka topic |
| **Event** | One raw message from a source, stored as-is | `{"type":"WORKFLOW_FAILED","workflowName":"order-settlement",...}` |
| **Schema** | Recognises a kind of event and maps its fields (severity, source, time, title) to a common shape | "anything with `type = WORKFLOW_FAILED` is a workflow failure; severity comes from `level`" |
| **Rule** | A filter plus who to tell and how the alert looks | `type = WORKFLOW_FAILED AND environment = prod` → group *Settlements on-call* on ntfy and UI |
| **Alert** | What a person acts on. Repeats of the same problem raise the count instead of opening new alerts | *Settlement failed at book-trade* (×3) |
| **Person / group** | Who gets notified and who may approve | *Settlements on-call* = Marek, Julia |
| **Preferences** | Each person's channels per severity and quiet hours | critical → UI + ntfy; quiet 20:00-08:00 |
| **Runbook** | What to do about an alert: text instructions, or automated steps | retry the workflow → if it still fails, escalate (needs approval) |

An alert is **open**, then optionally **acknowledged** (someone is on it), then **resolved**, either by a person or automatically when the source reports that the problem is gone. Resolved alerts drop out of Approvals.

### The filter language

Rules, the alert feed and runbook conditions all use the same filter language:

```text
type = WORKFLOW_FAILED AND environment = prod
alert.severity >= warning AND alert.status != resolved
alert.source = payments-api AND alert.count > 1
```

Bare names (`type`, `payload.desk`) read the original event; `alert.*` reads the alert itself. Combine with `AND`, `OR` and parentheses. The editors check your filter as you type.

---

## Using the app

The sidebar has two sections: **Alerts** for day-to-day work and **Configuration** for setting things up. Your account menu (top right) has your notification preferences and sign-out.

### Alerts

| Page | What you do there |
| --- | --- |
| **Alert feed** | See every alert live. Filter, sort, star, and click through to details. |
| **Alert detail** | The event's fields, the matching rule, runbooks with live step progress (Run now, Approve, Skip, Remove), suggestions, and the audit trail. Acknowledge and resolve here. |
| **Approvals** | Every automated runbook step waiting for a person, across all open alerts, with a badge count in the sidebar. Approving runs the step immediately; skipping moves the runbook on without it. Your name is recorded either way. |
| **Events** | Everything that arrived, newest first, including events that no schema recognises. Turn an unrecognised event into a schema in one click. |

### Configuration

| Page | What you set up |
| --- | --- |
| **Rules** | When to alert and who to tell: the filter, recipients (people or groups), forced channels, and the alert's title and fields. |
| **Runbooks** | Shared runbooks that match alerts by filter. Text runbooks are instructions; automation runbooks are ordered steps (`http`, `escalate`, `wait`) with optional conditions (`if`), retries, and `approval: required` plus an `approvers` group. |
| **Sources** | Where events come from: HTTP endpoint, log file tail, Redis stream or Kafka topic, and how to parse them. |
| **Schemas** | How to recognise an event type and map its fields. Start from a sample event. |
| **People & groups** | Who exists, their ntfy topic, group membership, and who may edit rules. |
| **Channels** | Delivery status for Dashboard, Phone (ntfy) and Email. Failed deliveries retry on their own; the ones that keep failing land in dead letters, where you can resend them. |
| **Connect Claude** | How to let Claude configure the service and handle alerts for you. |

### Notification preferences

From the account menu → **Notification preferences**, choose for each severity which channels you want: **Dashboard** (in the app), **Phone** (ntfy push) or **Email** and set quiet hours in your time zone. A rule can force channels (for example, always ntfy for critical payments alerts) when it must reach people regardless.

---

## Who can do what

- **Signing in**: pick an account or create one. There are no passwords (see [What is mocked](#what-is-mocked)).
- **Editing rules, people and groups**: only accounts with *can create rules*. New accounts can't; an admin can enable it under **People & groups**. In the demo, Anna, Julia and Tomasz can.
- **Approving or skipping runbook steps**: you must be signed in. If the step names an `approvers` group, only members of that group can decide it; this is enforced by the server, not just the buttons. Steps without an `approvers` group can be decided by anyone signed in. Steps on resolved alerts can no longer be decided.
- **Everything is audited**: acknowledgements, resolutions, approvals, skips and runbook removals are recorded with who did them and when.

---

## Configuring without the UI

### YAML files

Everything in `config/` (sources, schemas, rules, people, groups, preferences, runbooks) is loaded on start and **watched live**: edit a file and the change applies within seconds. Deleting a file deletes the entity. Formats are in [docs/config-formats.md](docs/config-formats.md). A rule looks like this:

```yaml
id: settlements-workflow-failed
name: Team Settlements
enabled: true
when: 'type = WORKFLOW_FAILED AND workflowName = order-settlement AND environment = prod'
who:
  - recipients:
      - { type: group, id: settlements-oncall }
    force: [ntfy, ui]
looks:
  titleTemplate: 'Settlement failed at {{step}}'
  fields: [step, error.message]
```

### HTTP API

Everything the UI does goes through a documented API. The OpenAPI document is at <http://localhost:3000/api/openapi.json>, and a readable reference is in [docs/api.md](docs/api.md). Send an event to an HTTP source:

```sh
curl -X POST http://localhost:3000/ingest/demo-http \
  -H 'content-type: application/json' \
  -d '{"type":"WORKFLOW_FAILED","workflowName":"order-settlement","environment":"prod","step":"book-trade"}'
```

### Claude

Give Claude (or any agent that can make HTTP calls) the OpenAPI URL and ask in plain words:

> Using the API described at http://localhost:3000/api/openapi.json, add an http source `billing`, a schema for events shaped like `{"invoice": {"id": "INV-1", "status": "failed", "amount": 120}}`, and a rule that notifies the pricing-team group on severity >= error. Then send a sample event to `/ingest/billing` and check that an alert appears.

Or connect the bundled MCP server (see [MCP server](#mcp-server) below).

---

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| `just up` says Node 22.6+ is required | The stack is already running; upgrade Node and run `just up` again to seed. |
| `not healthy after 120 s` | Run `docker compose ps` and `docker compose logs app` to see which service failed. Make sure ports 3000, 8080, 8025, 4100 and 19092 are free. |
| No alerts appear | Run `just demo`. Check **Events**: if events arrive but say "no schema", add a schema; if they're recognised but no alert appears, check that a rule matches and is enabled. |
| No ntfy notification | Subscribe to the right topic (`alerting-<person>`), check that person's preferences and quiet hours, and look under **Channels** for failed deliveries. |
| Approve button is greyed out | You're not signed in, or you're not in the step's approvers group (the card says which group). |
| Start over with clean data | `docker compose down -v && just up` |

---

## Reference

### Docs

- [Architecture](docs/architecture.md): processes, streams, storage
- [Config formats](docs/config-formats.md): YAML and JSON for every entity
- [API reference](docs/api.md)
- [Extending](docs/extending.md): new source types, parsers, channels, runbook actions and API routes
- [Performance](docs/performance.md)

### Commands

| Command | What it does |
| --- | --- |
| `just up` | Build, start, wait for health, seed demo data |
| `just demo` | Send demo traffic (see options below) |
| `just longtest` | 15 minutes of traffic, including an unknown event type to map live |
| `just down` | Stop the stack |
| `just test` / `just lint` | Run the tests / lint and typecheck |
| `just mcp` | Run the MCP server |
| `just loadtest` | Load test (see [docs/performance.md](docs/performance.md)) |
| `just docs-api` | Regenerate `docs/api.md` from the OpenAPI document |

### Demo data and traffic

- **Seeded by `just up`** (from `config/` and `scripts/seed/seed.ts`): people (anna, ewa, julia, marek, piotr, tomasz), groups (counterparty-support, pricing-team, rates-desk, settlements-oncall), three schemas, four rules, the runbooks, four demo sources (`demo-http`, `demo-logs` tailing `/tmp/demo-logs/*.log` in the app container, `demo-stream` on Redis stream `demo:events`, `demo-kafka` on Kafka topic `demo.events`) and Anna's preference (critical to UI + ntfy, quiet hours 20:00-08:00 Europe/Warsaw, UI only).
- **`just demo`** first sends a fixed showcase (about 19 events, a few seconds), then about 2 random events/s until 60 s are up, round-robin over HTTP, file tail, Redis stream and Kafka (Kafka is skipped with a warning if the broker isn't reachable). The showcase alone gives all four severities, several sources (`payments-api`, `pricing-engine-emea`, `pricing-engine-apac`, `pricing-engine-staging`, `order-settlement`, `trade-gateway`), `prod` and `staging`, repeating alerts and alerts that resolve.
- **Options**: `just demo --once` (one of each type through each source), `--burst` (about 30 random events as fast as possible), `--no-showcase`, `--rate 5 --duration 30`, `--count 20`. Sends through file tail and Redis cost 0.3-1 s each, so the real rate may be lower than requested.
- **`just longtest`**: 15 minutes of traffic; from 10 s on about 30% of events are a stale market-data feed no schema recognises (`{"eventName": "md.feed.stale", "level": "SEV2", "detectedAt": <epoch s>, ...}`). Map it live by adding a schema with `match: eventName = md.feed.stale` (severity from `level`: SEV1 → critical, SEV2 → error, SEV3 → warning; time from `detectedAt`). Flags: `--unknown-share 0.5`, `--unknown-after 30`, `--duration`.
- **Filters to try** on the showcase: `alert.severity = critical` (4 alerts), `alert.source = payments-api` (prod critical ×3 and a resolved staging critical), `alert.environment = staging`, `alert.status != resolved`, `alert.count > 1`, or combined: `alert.severity >= warning AND alert.environment = prod AND alert.status != resolved`.

### Kafka source

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

### MCP server

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

### Environment variables

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

### What is mocked

- **Sign-in**: a profile picker with no passwords. The API identifies you by a session cookie or an `X-Account` header, and neither is verified, so don't expose this to an untrusted network.
- **Upstream systems**: `demo-service` stands in for the systems runbook HTTP steps call, and events come from `just demo`.
- **Delivery**: ntfy runs as a local container; email goes to Mailpit, not real inboxes.

### Performance

At 5000 events/s for 60 s both tested configurations are overloaded: sustainable throughput is about 519 events/s with 1 worker and 930 events/s with 2 workers, with no events lost but latency dominated by queueing. Details, history and how to re-run (`just loadtest`) are in [docs/performance.md](docs/performance.md); raw results are in [results/](results/).
