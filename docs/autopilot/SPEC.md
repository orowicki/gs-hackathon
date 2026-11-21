---
# Set to true when this file is complete. The launcher refuses to start otherwise.
ready: true
profile: hackathon        # core | research | hackathon
budget_usd: 100       # per autopilot run; each of the 3 team members runs their own autopilot
---

# SPEC

> Human-owned. The agent reads this and never edits it. Decisions go in DECISIONS.md;
> when a decision changes the goal, update this file so it stays current.
>
> Background: the organisers' brief is `docs/human/GIVEN_SPEC.md` (read it; Appendix A has the
> sample events, Appendix B the sample runbooks). The UI source of truth is `docs/design/UI.md`.
> Where this file and UI.md disagree on UI details, UI.md wins; on everything else this file wins.

## Goal

A flexible alerting and notification service built for a hackathon demo (5-minute video plus
measured performance numbers), not for production. It ingests events from an HTTP endpoint, tailed
log files and Redis Streams, in any schema. Users add schemas and sources through a UI that
non-engineers (support, business) can use, or through plain YAML files reloaded live, or through a
documented HTTP API. Teams write rules that turn matching events into alerts, decide who receives
them, and decide how they look. Each recipient chooses how they are notified (live UI feed, ntfy
mobile push). Alerts are deduplicated, delivery is retried and never lost, and runbooks (text or
automation) tell people what to do next and can run approved actions. **Everything a user can do in
the UI is also possible through the HTTP API and the YAML config**, so a user can ask an external
LLM agent such as Claude to configure sources, schemas and rules for them. Anything a real product
needs but the demo does not (passwords and real authentication, multi-tenancy, credentials
management) is out of scope. **Accounts are in scope (must-have):** people sign in as themselves,
without a password.

## Concepts (the data model; build exactly these)

- **Source:** where raw messages come from. Types: `http` (`POST /ingest/{sourceId}`, accepts one
  JSON object, a JSON array, or NDJSON), `file_tail` (path or glob, reads new lines as they are
  appended), `redis_stream` (stream name, consumer group). Each source names a **parser**: `json`,
  `logfmt`, `regex` (named groups) or `raw` (fallback: anything unparseable becomes `{ "raw": "<text>" }`).
  Source types are plugins behind one interface (`configSchema` + `start(config, emit)`); the config
  form in the UI is generated from `configSchema`.
- **Schema (event type):** how to recognise an event (`match`, a filter expression) and how to map it
  onto the **common fields**: `severity` (ordered: critical > error > warning > info; default info),
  `title`, `source` (the system that emitted the event, e.g. `payments-api`; not the ingest
  connector, which is `sourceId`), `environment`, `dedupKey`, `sourceStatus` (firing | resolved, as
  reported by the source; feeds auto-resolve), `occurredAt`, and four optional ones: `type` (kind of event, finer than
  the schema, e.g. `alertname`), `message` (longer description, e.g. `error.message`), `entity` (the
  main object the alert is about, e.g. a workflow ID, instrument or instance) and `runbookUrl`
  (e.g. `annotations.runbook_url`). Each common field is one of: a path (`labels.severity`), a
  constant, or a template (`"{{workflowName}}-{{step}}"`), plus an optional value map
  (`ERROR → error`) and default. Timestamps (ISO, epoch s, epoch ms) and numeric strings are
  normalised automatically. No conditional mapping and no user-defined common fields: anything else
  is reached through raw paths. Events that match no schema are still stored and their raw fields
  are usable in rules and filters.
- **Filter language** (one parser, used everywhere: rules, routing, runbook matching, the UI filter
  bar): fields are `alert.<commonField>` (e.g. `alert.severity`, `alert.source`, `alert.type`,
  `alert.sourceStatus`), `alert.schema`, `alert.status` (our alert lifecycle: open | acknowledged |
  resolved; the one status users see in the UI, not the same as `alert.sourceStatus`, which is what
  the source reported) or raw event paths (`payload.notional`, `error.code`). In a rule's `when`,
  which runs on incoming events before an alert exists, `alert.status` is not available: use
  `alert.sourceStatus`. Operators `=`, `!=`, `>`,
  `>=`, `<`, `<=`, `contains`, `in [..]`, `matches` (glob, e.g. `pricing-engine-*`); `>=`/`<=` on
  `alert.severity` use severity order. Logic `AND`, `OR`, `NOT`, parentheses. Keywords
  case-insensitive, field names case-sensitive. Parse errors return a plain-English message with a
  position. The parsed form is a JSON tree, which is what is stored and what the API accepts in
  addition to the text form.
- **Rule:** `when` (filter on events) → `who` (ordered list of rows `condition → recipients`, each row
  optionally `force: [channels]` that overrides recipients' preferences) → `looks` (title and body
  templates, list of fields to show, optional severity/colour override). Every matching rule fires;
  each person is notified at most once per alert. Rules change at runtime without restart.
- **People & groups:** a directory of people (name, role, `canCreateRules`, ntfy topic) and named
  groups of people. Rules route to people or groups. Every person is also an **account**.
- **Account (must-have, no passwords):** an account is a Person; there is no separate user table.
  - **Sign up:** create an account with a name (role optional; `canCreateRules` false by default).
    It is the same Person a rule can route to.
  - **Sign in:** pick your account from a list. No password, no email check. The server starts a
    session (random token stored server-side, sent as an httpOnly cookie) and remembers it across
    reloads and restarts until you sign out.
  - **Sign out:** ends the session.
  - API: `POST /api/accounts` (sign up), `POST /api/session` `{ personId }` (sign in),
    `GET /api/session` (who am I; 401 when signed out), `DELETE /api/session` (sign out). API
    clients such as an LLM agent may send `X-Account: <personId>` instead of the cookie.
  - The **current account** replaces the profile picker. It is the actor recorded for
    acknowledge, resolve, runbook approvals and config changes. Its `canCreateRules` is checked
    on the server (403 when false), not only by hiding `+` in the UI. "My notifications" and
    starred filters belong to it.
  - Signed out, the UI shows a sign-in page (account list plus "Create account"). The gear panel
    shows "Signed in as <name> (role)" and "Sign out".
- **Preferences:** per person or group: which channels for which severity, plus quiet hours, stored
  as filter conditions (`alert.severity = critical` → `ntfy-urgent`); the UI shows a simple
  severity × channel grid with quiet hours.
- **Alert:** created when a rule matches. Dedup: same rule + same `dedupKey` while the alert is not
  resolved → increment counter and `lastSeen`, no new notifications (unless severity increased).
  A recurrence after resolve opens a new alert. Status: open → acknowledged → resolved; this is the
  only status shown in the UI. An event with `sourceStatus: resolved` for the same rule + dedupKey
  auto-resolves it. Shared types: `Alert.status` (renamed from `Alert.state`) and the common field
  `sourceStatus` (renamed from `status`).
- **Channel:** plugin behind one interface `send(notification) → delivered | failed(retryable)`.
  Built in: `ui` (WebSocket/SSE push) and `ntfy` (HTTP POST to an ntfy server; priority from
  severity; click link to the alert; action buttons for Acknowledge and Approve). Delivery goes
  through a durable Redis queue with exponential-backoff retries; exhausted deliveries go to a
  dead-letter list visible in the UI with "retry now". Throttling per recipient: at most N
  notifications per X minutes on external channels, the rest bundled into one digest. The UI feed is
  never throttled.
- **Runbook:** attaches to alerts by a `matches` filter. Two fixed types:
  - `text`: Markdown/free text/link, shown with `{{field}}` values filled in (full in the alert
    detail, as a link in ntfy). Never executed.
  - `automation`: our own YAML step list. Actions: `http` (method, URL, headers, templated body),
    `escalate` (notify a group), `wait` (duration). Each step has `approval: none | required`.
    Steps run in order; `required` steps wait for an Approve click (UI or ntfy action button).
    Action types are plugins.
  Every executed, approved or skipped step is written to the alert's audit log (who, when, result).
- **Suggestion:** a small, unobtrusive "Suggest a change" link on the alert detail page; the text is
  attached to the rule, and the rule's page lists open suggestions with Accept/Dismiss.

## Acceptance criteria

1. **Fresh start:** on a clean clone, `just up` (one command) starts everything with docker compose
   (app, Redis, Postgres, ntfy) and seeds demo data; the UI is reachable within 2 minutes on a
   laptop. The README states the exact commands and what is mocked.
2. **Sources:** an HTTP POST, a line appended to a tailed log file, and an `XADD` to a Redis Stream
   each produce a stored event within 1 s. An unparseable line produces an event with `raw` set.
   Covered by an automated end-to-end test per source type.
3. **Schemas:** the three Appendix A events are seeded as schemas; each maps to the correct common
   fields, including `type`, `message` and `entity` (tested). A new schema created via `POST /api/schemas` (or by adding a YAML file to
   `config/schemas/`) is used for the next event without a restart (tested).
4. **Filter language:** a parser test suite covers every operator, precedence, case rules, glob
   `matches`, severity ordering, and error messages with positions; text ↔ tree round-trips.
5. **Rules at runtime:** the four example rules in GIVEN_SPEC Appendix A (adapted to our channels)
   are seeded. Creating, editing and deleting a rule via the API, the UI or a YAML file in
   `config/rules/` takes effect within 2 s without a restart (tested).
6. **Routing & preferences:** tests show: a person in two matched groups is notified once; channels
   follow their preferences by severity and quiet hours; a `force` row overrides preferences.
7. **Dedup & throttling:** 500 identical events in under a minute produce one alert with count 500
   and at most one notification per recipient (tested). Throttling bundles excess notifications
   into a digest (tested).
8. **Delivery survives failure:** with the ntfy server stopped, alerts keep being created; after it
   restarts, all pending notifications are delivered (automated test, no lost notifications).
   Exhausted retries appear in the dead-letter list and can be retried from the UI.
9. **Runbooks:** a text runbook renders with event values filled in. The Appendix B YAML example,
   adapted to our format, runs: auto steps execute against a fake demo service, the
   `approval: required` step waits until approved via the API (which the UI and ntfy buttons call),
   and the audit log shows each step with actor and time (tested).
10. **UI:** implements `docs/design/UI.md` (landing page, filter bar with validation, autocomplete
    and starred filters, live list with push updates, expanded rows, alert detail with "JSON without
    brackets"), plus the config pages reachable from the gear panel: Sources (with live preview of
    incoming messages and parser choice), Schemas (paste a sample, click fields to map common fields,
    value maps), Rules (`/rules/new` and edit: When → Who → Looks, using the same filter input, with a
    "test against recent events" count), People & groups, Channels (status + dead letters), and
    My notifications. Export/import of a schema, source or rule as YAML. Playwright smoke tests cover
    each page.
11. **LLM-configurable:** an OpenAPI document is served at `/api/openapi.json` and covers every
    endpoint the UI uses; no UI feature uses an undocumented endpoint (checked by a test that diffs
    UI API calls against the OpenAPI paths).
12. **Performance, measured:** `just loadtest` sends 5,000 events/s for 60 s and writes
    `results/loadtest-<date>.json` and a chart (PNG or HTML) with throughput and end-to-end latency
    (ingest → alert pushed to UI / enqueued to ntfy) p50 and p99. Targets: p50 < 50 ms, p99 < 250 ms,
    zero lost events. The same script with 2 worker instances shows higher sustainable throughput
    than 1. Numbers in the README come from these files, not estimates.
13. **Visual quality:** each UI milestone commits screenshots of every page (light and dark) to
    `docs/screenshots/`; the UI follows UI.md's tokens and "Do not" list. A human review decision
    is opened in DECISIONS.md for each UI milestone before it counts as done.
14. **Accounts (must-have):**
    - Signing up, signing in by picking an account, reloading the page and signing out all work
      in the running app (`just up`), with no password anywhere.
    - Acknowledging an alert and approving a runbook step record the signed-in account as the
      actor in the audit log.
    - `POST /api/rules` as an account without `canCreateRules` returns 403.
    - The seeded demo people can sign in.
    - Only a few unit tests for the session logic are needed; bigger tests come later.

## Constraints

- TypeScript end to end: Node backend, React + Vite frontend, shared types in one package
  (monorepo with workspaces). Postgres for rules, schemas, sources, people, alerts, audit log;
  Redis for queues between stages, dedup state, rule-change broadcast and delivery retries.
- Backend is stateless apart from Redis and Postgres, so ingest and worker processes can be run as
  multiple instances.
- Config can be edited three ways that share one store: UI, HTTP API, YAML files in `config/`
  (watched and reloaded live).
- Dependencies: well-known, maintained open-source libraries only; no paid APIs. ntfy runs as a
  local container by default (the public ntfy.sh may be used via config, with random topic names).
- UI: follow `docs/design/UI.md` exactly. Install Anthropic's `frontend-design` skill before
  building UI (human setup step). No gradients, emoji, card-everything, or untouched component
  library styling.
- Secrets only in `.env` (never committed); `.env.example` documents every variable.
- Lint: `just lint` · Tests: `just test` · Start: `just up` · Load test: `just loadtest`
- Team mode: three autopilots work in parallel after M1. Each track keeps to its own folders
  (A: `packages/ingest`, schemas; B: `packages/engine`, `packages/delivery`; C: `packages/web`
  feed/detail, `packages/runbooks`) and builds and tests against the fixtures and contracts from M1,
  not against other tracks' unfinished code. Changing a shared contract needs a DECISIONS.md entry.

## Out of scope

- Passwords, OAuth/SSO, email verification or any real authentication (accounts are in scope,
  without passwords; see Account). Authorisation beyond the `canCreateRules` flag. Multi-tenancy.
- SMS and phone call channels (README explains they would be one plugin, e.g. Twilio).
- Polled-API source, XML/CSV parsers, conditional schema mapping.
- Automatic detection of unseen schemas (schemas are set up by a user first).
- On-call schedules beyond quiet hours; working-hours calendars.
- Arbitrary runbook automation formats; LLM conversion of text runbooks (stretch only).
- Production hardening: backups, HA Postgres/Redis, credentials vault, rate limiting of the API.

## Milestones

M1 Contracts & skeleton: monorepo, docker compose (Redis, Postgres, ntfy), shared types (Event, Alert, Rule, Schema, Source, Person, Group, Notification, Runbook), Redis stream names, API route list + OpenAPI stub, fixture events/alerts from Appendix A, filter-language parser + evaluator with tests, config store with YAML watch + live reload, empty React shell with UI.md tokens, `just up/lint/test` green. Keep small: the other tracks wait on it.
M2 Track A, sources & parsers: http, file_tail, redis_stream source plugins; json, logfmt, regex, raw parsers; per-source end-to-end tests.
M3 Track A, schemas: schema matching and common-field mapping (path, constant, template, value map, default), time/number normalisation, unmatched events kept, seeded Appendix A schemas.
M4 Track A, config pages: Sources page with live preview and parser picker, Schemas page with paste-a-sample click-to-map, export/import YAML, screenshots.
M5 Track A, load test: `just loadtest`, 1 vs 2 worker comparison, results JSON + chart, README performance section.
M6 Track B, rule engine: rules (when/who/looks), people & groups, preferences with quiet hours, force override, dedup with counter, auto-resolve, throttling with digest, seeded example rules.
M7 Track B, delivery: channel plugin interface, ui and ntfy channels (priority, click link, Acknowledge/Approve action buttons), durable queue, retries with backoff, dead-letter list, channel-down test.
M8 Track B, config pages: Rules editor (`/rules/new`, edit, test against recent events, suggestions list), People & groups, My notifications, Channels with dead letters and retry, screenshots.
M9 Track C, live feed & detail: UI.md landing page (filter bar, validation, autocomplete, starred filters, live push list, expanded rows, profile picker in gear panel), alert detail with readable event data, ack/resolve, Suggest a change, screenshots.
M10 Track C, runbooks: runbook matching, text runbooks with templating, automation runner (http, escalate, wait), approvals via API/UI/ntfy, audit log on alert detail, fake demo service for actions.
M11 Track C, onboarding: README quick start (commands, timings, what is mocked, how to add a source/schema/channel/action type, how to let Claude configure it via the API), seeded demo data and a demo event generator script.
M12 Integration: full pipeline end to end with all Appendix A events and Appendix B runbooks, OpenAPI coverage test, all acceptance criteria re-verified.
M14 Accounts (MUST-HAVE: do it before M12 and before any M13 stretch work; numbered last only because it was added late): backend sessions (table or Redis keys), the four account/session endpoints and the `X-Account` header, actor taken from the session for ack/resolve/approvals/config changes, server-side `canCreateRules` check, OpenAPI entries, seeded people can sign in. UI (sign-in page, gear panel) is built by people per NOTES-HUMAN: autopilots do the backend and file a plain issue for the UI part.
M13 Stretch (first free track takes one at a time): Kafka source plugin, grouping (group by fields per window), email channel over SMTP (Mailpit by default), MCP server wrapping the API, LLM conversion of text runbooks into automation steps.
