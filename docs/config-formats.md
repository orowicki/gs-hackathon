# Config file formats

Reference for the YAML files in `config/` (and for the same entities when created through the API). Every field list below is taken from the shared types (`packages/shared/src/types/`) and the loader (`packages/config/src/watcher.ts`, `store.ts`); examples are checked by `tests/docs/config-examples.test.ts`: they are parsed with the real loader (`fromYaml`, `entityId`), filters with the real filter parser, runbooks with `validateRunbook`, and the other kinds with field checks in the test that mirror the shared types. A wrong example fails `npm test`.

## How files are loaded

- Layout: one entity per file; the directory is the kind (`config/sources/`, `schemas/`, `rules/`, `people/`, `groups/`, `runbooks/`). Preferences have no directory (see [Preferences](#preferences)).
- Extensions: `.yaml` and `.yml` (case-insensitive). Other files, such as `.gitkeep` or `README.md`, are ignored.
- File name: free. The entity id is the `id` field in the file; if it is missing, the file name without extension is used (not for preferences). The id must be a non-empty string. Two files with the same id: the duplicate is reported and the entity is overwritten by whichever file is read later (directory scan order), so avoid duplicate ids.
- The app reads the directory from the `CONFIG_DIR` environment variable (default `./config`; compose mounts `./config` at `/app/config`). If the directory does not exist, live reload is disabled and an error is logged.
- Seed vs live reload (`packages/api/src/config-watch.ts`, `watchConfigDir` in `@alerting/config`): on start, a file is loaded only if no entity with that id exists in the database yet, so edits made through the API survive restarts. After start, adding or editing a file upserts the entity (writes are debounced by about 100 ms), and deleting a file deletes the entity. Other processes are told through the config change channel.
- An invalid YAML file or an invalid entity is logged with the file path and the reason, then skipped. It never stops the watcher. The watcher never writes to the files.
- The loader itself only checks that the file is a YAML object with a usable id. Filters, runbook steps and the like are validated when used (and by the API on write), so the field tables below are the contract; the test applies the stricter checks too.

## Filter language (short)

Used by `when`, `condition`, `match`, `matches` and preference `when`. A filter is text, or the equivalent JSON tree (the API stores either). Empty text matches everything.

- Fields: `alert.<field>` reads the normalised alert (`alert.severity`, `alert.source`, `alert.title`, `alert.environment`, ...); anything else is a path into the raw event (`payload.notional`, `labels.service`, `error.code`).
- Operators: `=  !=  >  >=  <  <=  contains  in  matches`; combine with `AND`, `OR`, `NOT` and parentheses (NOT binds tighter than AND, then OR).
- `matches` is a glob (`*` any characters, `?` one character); `contains` is a substring (or list membership); `in` takes a list: `alert.environment in [prod, staging]`.
- Severity compares by rank: `alert.severity >= warning` also matches `error` and `critical`.
- Dates: `>`, `>=`, `<`, `<=` compare as times when the value is `now`, `now-<n><unit>` (units `s m h d w`, e.g. `now-24h`, `now-7d`) or an ISO date (`2026-11-21`, `"2026-11-21T09:00:00Z"`). The field may hold an ISO string or an epoch in seconds or ms. `alert.lastSeen` / `alert.firstSeen` (alerts only, not in a rule's `when`) and `alert.occurredAt` are the time fields: `alert.lastSeen >= now-24h` is "seen in the last day".
- A missing field makes every operator false except `!=`.
- Examples: `alert.severity = critical AND alert.source matches payments-*`, `type = WORKFLOW_FAILED AND NOT environment = test`.

Full syntax, semantics and error messages: [docs/autopilot/interfaces/filter.md](autopilot/interfaces/filter.md).

## Sources

Directory `config/sources/` (kind `source`). Where events come from and how a raw message is parsed. The repository ships no seeded source file; the demo sources live in `scripts/seed/seed.ts`, and the example below is the demo HTTP one written as a file.

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes (or file name) | |
| `name` | string | yes | Display name. |
| `enabled` | boolean | yes | Disabled sources do not ingest. |
| `type` | `http` \| `file_tail` \| `redis_stream` | yes | Selects the source plugin. |
| `parser.type` | `json` \| `logfmt` \| `regex` \| `raw` | yes | |
| `parser.pattern` | string | only for `regex` | Pattern with named groups. |
| `config` | object | yes | Depends on `type`, see below. |

`config` by type: `http` takes `{}` (events are posted to `POST /ingest/{sourceId}`); `file_tail` takes `path` (string, required, path or glob); `redis_stream` takes `stream` and `consumerGroup` (both strings, both required). Details: [source-plugin.md](autopilot/interfaces/source-plugin.md).

<!-- kind: sources -->
```yaml
id: demo-http
name: Demo (HTTP)
enabled: true
type: http
parser:
  type: json
config: {}
```

<!-- kind: sources -->
```yaml
id: demo-logs
name: Demo (log files)
enabled: true
type: file_tail
parser:
  type: json
config:
  path: /tmp/demo-logs/*.log
```

## Schemas

Directory `config/schemas/` (kind `schema`). An event type: how to recognise an event and map it onto the common alert fields.

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes (or file name) | |
| `name` | string | yes | |
| `match` | filter | yes | Evaluated on the parsed event. |
| `mapping` | object | yes | Common field name -> field mapping. Unmapped fields fall back to defaults (`severity` is `info`). |

Mapping keys: `severity`, `title`, `source`, `environment`, `dedupKey`, `sourceStatus` (`firing` or `resolved`; legacy `status` is accepted as an alias), `occurredAt`, and the optional `type`, `message`, `entity`, `runbookUrl`.

Each mapping value is an object with `kind` and:

| `kind` | Extra required field | Meaning |
|---|---|---|
| `path` | `path` (string) | Dotted path into the event. |
| `constant` | `value` (string) | Fixed value. |
| `template` | `template` (string) | Text with `{{path}}` placeholders. |

All kinds also accept `default` (string, used when the path or template gives nothing) and `valueMap` (object of string -> string, rewrites the result, for example `ERROR: error`).

Example from `config/schemas/metric-breach.yaml`:

<!-- kind: schemas; file: config/schemas/metric-breach.yaml -->
```yaml
id: schema-metric-breach
name: Metric threshold breach (Prometheus/Alertmanager style)
match: alertname matches * AND labels.service matches * AND startsAt matches *
mapping:
  severity: { kind: path, path: labels.severity }
  title: { kind: template, template: "{{alertname}} on {{labels.service}}" }
  source: { kind: path, path: labels.service }
  environment: { kind: path, path: labels.environment, default: prod }
  dedupKey: { kind: template, template: "{{alertname}}-{{labels.service}}" }
  sourceStatus: { kind: path, path: status, default: firing }
  occurredAt: { kind: path, path: startsAt }
  type: { kind: path, path: alertname }
  message: { kind: path, path: annotations.summary }
  entity: { kind: path, path: labels.instance }
  runbookUrl: { kind: path, path: annotations.runbook_url }
```

Example from `config/schemas/trade-rejected.yaml`:

<!-- kind: schemas; file: config/schemas/trade-rejected.yaml -->
```yaml
id: schema-trade-rejected
name: Trade rejected
match: meta.schema matches "trade.rejected.*"
mapping:
  severity: { kind: constant, value: info }
  title: { kind: template, template: "Rejected {{payload.currency}} {{payload.notional}} — {{payload.reason}}" }
  source: { kind: path, path: meta.producer }
  environment: { kind: constant, value: prod }
  dedupKey: { kind: path, path: payload.tradeId }
  sourceStatus: { kind: constant, value: firing }
  occurredAt: { kind: path, path: meta.ts }
  type: { kind: path, path: meta.schema }
  message: { kind: path, path: payload.reason }
  entity: { kind: path, path: payload.tradeId }
```

## Rules

Directory `config/rules/` (kind `rule`). Who is told about which alerts, and how the alert looks.

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes (or file name) | |
| `name` | string | yes | |
| `enabled` | boolean | yes | |
| `when` | filter | yes | Which alerts the rule applies to. |
| `who` | list of rows | yes | See below. |
| `looks.titleTemplate` | string | yes | `{{alert.title}}`-style placeholders. |
| `looks.bodyTemplate` | string | no | |
| `looks.fields` | list of strings | yes | Field paths shown on the alert. |
| `looks.severityOverride` | `info` \| `warning` \| `error` \| `critical` | no | |
| `looks.colour` | string | no | CSS colour token or hex. |
| `dedupFields` | list of common field names | no | Dedup key source when the event has none. |
| `createdAt`, `updatedAt` | ISO-8601 string | yes | Quote the value so YAML keeps it a string. |

A `who` row: `recipients` (list of `{ type: person | group, id }`, required); `condition` (filter, optional, omit for "everyone else"); `force` (list of channel ids such as `ui`, `ntfy`, optional, overrides the recipients' preferences).

Example from `config/rules/pricing.yaml`:

<!-- kind: rules; file: config/rules/pricing.yaml -->
```yaml
# Team Pricing: pricing-engine-* at warning or above, ui only.
# The spec also asks to group these into one alert per instrument every 5 minutes;
# grouping is out of scope for this rule (dedup/grouping is handled elsewhere).
id: pricing-engine-warnings
name: Team Pricing
enabled: true
when: 'alert.source matches pricing-engine-* AND alert.severity >= warning'
who:
  - recipients:
      - { type: group, id: pricing-team }
    force: [ui]
looks:
  titleTemplate: '{{alert.title}}'
  fields: [alert.source, alert.severity]
createdAt: '2026-11-01T00:00:00Z'
updatedAt: '2026-11-01T00:00:00Z'
```

Example from `config/rules/settlements.yaml`:

<!-- kind: rules; file: config/rules/settlements.yaml -->
```yaml
# Team Settlements: failed order-settlement workflows in prod page the on-call group on ntfy and ui.
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
  colour: red
createdAt: '2026-11-01T00:00:00Z'
updatedAt: '2026-11-01T00:00:00Z'
```

## People

Directory `config/people/` (kind `person`).

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes (or file name) | |
| `name` | string | yes | |
| `role` | string | yes | |
| `canCreateRules` | boolean | yes | |
| `ntfyTopic` | string | no | Topic used by the `ntfy` channel. |

Example from `config/people/anna.yaml`:

<!-- kind: people; file: config/people/anna.yaml -->
```yaml
id: anna
name: Anna Kowalska
role: Payments lead
canCreateRules: true
ntfyTopic: alerting-anna
```

## Groups

Directory `config/groups/` (kind `group`).

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes (or file name) | |
| `name` | string | yes | |
| `memberIds` | list of person ids | yes | |

Example from `config/groups/rates-desk.yaml`:

<!-- kind: groups; file: config/groups/rates-desk.yaml -->
```yaml
id: rates-desk
name: Rates desk
memberIds: [tomasz, anna]
```

## Preferences

Kind `preference`. There is no `config/preferences/` directory: the watcher does not load preferences. They are stored through the API (`PUT /api/people/{id}/preferences` or `PUT /api/groups/{id}/preferences`, JSON body) and the YAML below is the same entity (it is the seeded preference of Anna from `scripts/seed/seed.ts`). One preference per person or group; its storage id is `person:<ownerId>` or `group:<ownerId>`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `ownerType` | `person` \| `group` | yes | |
| `ownerId` | string | yes | Id of the person or group. |
| `rules` | list | yes | First matching rule wins. Each has `when` (filter) and `channels` (list of channel ids). The API accepts `when` only as a JSON filter tree. |
| `quietHours.from`, `quietHours.to` | string `HH:MM` | no | 24 h, local to `timezone`. |
| `quietHours.timezone` | string | with `quietHours` | IANA name, for example `Europe/Warsaw`. |
| `quietHours.allowChannels` | list of channel ids | no | Still allowed during quiet hours (default `[ui]`). |

<!-- kind: preferences -->
```yaml
ownerType: person
ownerId: anna
rules:
  - when: { type: cmp, field: alert.severity, op: "=", value: critical }
    channels: [ui, ntfy]
quietHours:
  from: "20:00"
  to: "08:00"
  timezone: Europe/Warsaw
  allowChannels: [ui]
```

## Runbooks

Directory `config/runbooks/` (kind `runbook`). Two types, chosen by `type`.

Common fields: `id` (string, required or file name), `name` (string, required), `type` (`text` or `automation`, required), `matches` (filter, optional, but a missing or empty `matches` matches every alert, so the runbook is suggested for all of them: always set it. Only an unparseable `matches` is never suggested).

| Type | Extra fields |
|---|---|
| `text` | `content` (string, required): Markdown or text with `{{field}}` placeholders. Never executed. |
| `automation` | `steps` (list, required, each step below). |

Step fields: `action` (`http`, `escalate` or `wait`, required), `name` (string, optional, may use placeholders), `approval` (`none` or `required`, default `none`), plus per action:

| Action | Fields |
|---|---|
| `http` | `method` (string, required), `url` (string, required), `headers` (map of string, optional), `body` (string, optional, templated) |
| `escalate` | `group` (group id, required) |
| `wait` | `duration` (required, like `500ms`, `30s`, `2m`, `1h`; limited to 15 minutes by default) |

Placeholders (`{{alert.entity}}`, `{{error.code}}`) are filled from the alert and the event.

Text runbook, `config/runbooks/pricing-latency.yaml`:

<!-- kind: runbooks; file: config/runbooks/pricing-latency.yaml -->
```yaml
id: pricing-latency
name: Pricing latency
type: text
matches: alert.source matches "pricing-engine*" OR labels.service matches "pricing-engine*"
content: |
  When pricing latency goes over a second, it's usually the cache. Restart the pricing-engine instance named in the alert ({{alert.entity}}), wait 2 minutes, and if latency is still high, call the pricing on-call person.
```

Automation runbook, `config/runbooks/settlement-timeout.yaml`:

<!-- kind: runbooks; file: config/runbooks/settlement-timeout.yaml -->
```yaml
id: settlement-timeout
name: Settlement workflow timeout
type: automation
matches: type = WORKFLOW_FAILED AND error.code = TIMEOUT
# Note: the original "if retry fails twice" condition is approximated by the
# approval gate on the escalate step (our format has no conditional steps).
steps:
  - name: Check counterparty-service health
    action: http
    method: GET
    url: http://demo-service:4100/health
    approval: none
  - name: "Retry workflow {{workflowId}}"
    action: http
    method: POST
    url: "http://demo-service:4100/workflows/{{workflowId}}/retry"
    headers:
      content-type: application/json
    body: '{"workflowId":"{{workflowId}}","reason":"{{error.code}}"}'
    approval: none
  - name: Escalate to counterparty-support
    action: escalate
    group: counterparty-support
    approvers: settlements-oncall
    approval: required
```

`approvers` (optional group id) is notified, with an ntfy Approve button, when a step with `approval: required` waits; without it the alert's own recipients are notified.
