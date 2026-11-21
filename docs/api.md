# Alerting API reference

<!-- GENERATED FILE, do not edit by hand. Regenerate with `just docs-api`. -->

This page is generated from the OpenAPI document served at `/api/openapi.json`. Do not edit it by hand; run `just docs-api` after changing the API.

OpenAPI 3.1.0, API version 0.0.0.

## accounts

### POST `/api/accounts`

Create an account (a Person without rule-creation permission)

**Request body** (required)

Media type `application/json`: [AccountCreate](#schema-accountcreate)

Example `newcomer` (A new account):

```json
{
  "name": "Piotr Lis",
  "role": "Pricing engineer"
}
```

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 201 | `application/json` | [Person](#schema-person) | The created Person (canCreateRules false) |
| 400 | `application/json` | [Error](#schema-error) | Bad request (invalid id, body, filter or parameter) |
| 413 | `application/json` | [Error](#schema-error) | Payload too large |
| 503 | `application/json` | [Error](#schema-error) | Dependency or component not configured |

### GET `/api/session`

The signed-in person (session cookie or X-Account header)

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `application/json` | [Person](#schema-person) | The signed-in person (cookie, or X-Account: <personId> header for API clients) |
| 401 | `application/json` | [Error](#schema-error) | Not signed in |

### POST `/api/session`

Sign in as a person (no password); sets the session cookie

**Request body** (required)

Media type `application/json`: [SessionCreate](#schema-sessioncreate)

Example `anna` (Sign in as Anna):

```json
{
  "personId": "anna"
}
```

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `application/json` | [Person](#schema-person) | The person; the session cookie alerting_session is set (HttpOnly, SameSite=Lax, Path=/) |
| 400 | `application/json` | [Error](#schema-error) | Bad request (invalid id, body, filter or parameter) |
| 404 | `application/json` | [Error](#schema-error) | Not found |
| 413 | `application/json` | [Error](#schema-error) | Payload too large |
| 503 | `application/json` | [Error](#schema-error) | Dependency or component not configured |

### DELETE `/api/session`

Sign out (ends the session, clears the cookie)

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 204 |  |  | Signed out; the cookie is cleared |

## alerts

### GET `/api/alerts`

List alerts (filter, state, limit, before; sort=lastSeen|firstSeen|severity|count, order=asc|desc, offset=<n>). Default is lastSeen desc paged with the before cursor (x-next-before); non-default sort/order is paged with offset (x-next-offset; offset is ignored with the default sort) and combining before with a non-default sort is a 400

**Parameters**

| name | in | type | required | description |
| --- | --- | --- | --- | --- |
| `filter` | query | string | no | Filter expression text (takes precedence over `tree`) |
| `tree` | query | string | no | Filter tree as a JSON-encoded string |
| `state` | query | [AlertState](#schema-alertstate) | no | Only alerts in this state |
| `limit` | query | integer | no | Page size (default 50); clamped to 1..200, a non-numeric value falls back to the default |
| `before` | query | string | no | Opaque cursor from the x-next-before response header of the previous page (alerts). Only valid with the default sort (lastSeen desc); combined with a non-default sort/order it is a 400, use offset instead |
| `sort` | query | "lastSeen" \| "firstSeen" \| "severity" \| "count" | no | Sort key (default lastSeen) |
| `order` | query | "asc" \| "desc" | no | Sort direction (default desc) |
| `offset` | query | integer | no | Rows to skip, for paging with a non-default sort/order (use the x-next-offset response header). Ignored with the default sort (lastSeen desc); a non-numeric value is a 400 |

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `application/json` | [Alert](#schema-alert)[] | Alerts, newest activity first unless sorted otherwise |
| 400 | `application/json` | [Error](#schema-error) | Bad request (invalid id, body, filter or parameter) |

### GET `/api/alerts/summary`

Alert counts for stat panels (optional filter/tree, same as the list). open = open alerts; bySeverity counts open alerts; byStatus counts all. Not pushed on SSE: refetch when an `alert` event arrives on /api/stream

**Parameters**

| name | in | type | required | description |
| --- | --- | --- | --- | --- |
| `filter` | query | string | no | Filter expression text (takes precedence over `tree`) |
| `tree` | query | string | no | Filter tree as a JSON-encoded string |

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `application/json` | [AlertSummary](#schema-alertsummary) | Alert counts for stat panels |
| 400 | `application/json` | [Error](#schema-error) | Bad request (invalid id, body, filter or parameter) |

### GET `/api/alerts/{id}`

Get an alert with its event, runbooks and suggestions

**Parameters**

| name | in | type | required | description |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes |  |

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `application/json` | [AlertDetail](#schema-alertdetail) | The alert with its event and suggestions |
| 400 | `application/json` | [Error](#schema-error) | Bad request (invalid id, body, filter or parameter) |
| 404 | `application/json` | [Error](#schema-error) | Not found |

### POST `/api/alerts/{id}/ack`

Acknowledge an alert

**Parameters**

| name | in | type | required | description |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes |  |

**Request body**

Media type `application/json`: [AlertTransitionRequest](#schema-alerttransitionrequest)

Example `actor` (Acknowledge as Anna):

```json
{
  "actor": "anna"
}
```

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `application/json` | [Alert](#schema-alert) | The acknowledged alert |
| 400 | `application/json` | [Error](#schema-error) | Bad request (invalid id, body, filter or parameter) |
| 404 | `application/json` | [Error](#schema-error) | Not found |
| 409 | `application/json` | [Error](#schema-error) | Conflict with the current state |
| 413 | `application/json` | [Error](#schema-error) | Payload too large |

### GET `/api/alerts/{id}/audit`

Audit log of an alert

**Parameters**

| name | in | type | required | description |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes |  |

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `application/json` | [AuditEntry](#schema-auditentry)[] | Audit log of the alert |
| 400 | `application/json` | [Error](#schema-error) | Bad request (invalid id, body, filter or parameter) |
| 404 | `application/json` | [Error](#schema-error) | Not found |

### POST `/api/alerts/{id}/resolve`

Resolve an alert

**Parameters**

| name | in | type | required | description |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes |  |

**Request body**

Media type `application/json`: [AlertTransitionRequest](#schema-alerttransitionrequest)

Example `actor` (Resolve as Marek):

```json
{
  "actor": "marek"
}
```

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `application/json` | [Alert](#schema-alert) | The resolved alert |
| 400 | `application/json` | [Error](#schema-error) | Bad request (invalid id, body, filter or parameter) |
| 404 | `application/json` | [Error](#schema-error) | Not found |
| 409 | `application/json` | [Error](#schema-error) | Conflict with the current state |
| 413 | `application/json` | [Error](#schema-error) | Payload too large |

### GET `/api/audit`

Global audit log (filter by query: alertId, actor, action, before, limit)

**Parameters**

| name | in | type | required | description |
| --- | --- | --- | --- | --- |
| `alertId` | query | string | no | Only entries of this alert |
| `actor` | query | string | no | Only entries by this actor |
| `action` | query | string | no | Only this action |
| `before` | query | string | no | Opaque cursor from the x-next-before response header of the previous page (audit entries) or an ISO timestamp |
| `limit` | query | integer | no | Page size (default 50); clamped to 1..200, a non-numeric value falls back to the default |

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `application/json` | [AuditEntry](#schema-auditentry)[] | Audit entries, newest first |
| 400 | `application/json` | [Error](#schema-error) | Bad request (invalid id, body, filter or parameter) |

## channels

### GET `/api/channels`

Channel status

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `application/json` | [ChannelStatus](#schema-channelstatus)[] | Status per channel |
| 503 | `application/json` | [Error](#schema-error) | Dependency or component not configured |

### GET `/api/dead-letters`

List dead-lettered notifications

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `application/json` | [DeadLetter](#schema-deadletter)[] | Dead-lettered notifications |
| 503 | `application/json` | [Error](#schema-error) | Dependency or component not configured |

### POST `/api/dead-letters/{id}/retry`

Retry a dead letter now

**Parameters**

| name | in | type | required | description |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes |  |

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `application/json` | [Notification](#schema-notification) | The re-queued notification |
| 400 | `application/json` | [Error](#schema-error) | Bad request (invalid id, body, filter or parameter) |
| 404 | `application/json` | [Error](#schema-error) | Not found |
| 503 | `application/json` | [Error](#schema-error) | Dependency or component not configured |

## events

### GET `/api/events`

**NOT IMPLEMENTED YET** (issue #108): the server currently answers 404.

List stored events (filter, limit, before)

**Parameters**

| name | in | type | required | description |
| --- | --- | --- | --- | --- |
| `filter` | query | string | no | Filter expression text |
| `limit` | query | integer | no | Page size (default 50); clamped to 1..200, a non-numeric value falls back to the default |
| `before` | query | string | no | Opaque cursor from the x-next-before response header of the previous page (events) |

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `application/json` | [Event](#schema-event)[] | Stored events, newest first |
| 400 | `application/json` | [Error](#schema-error) | Bad request (invalid id, body, filter or parameter) |

### GET `/api/events/recent`

Most recent events (for autocomplete and previews)

**Parameters**

| name | in | type | required | description |
| --- | --- | --- | --- | --- |
| `limit` | query | integer | no | Page size (default 50); clamped to 1..1000, a non-numeric value falls back to the default |

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `application/json` | [Event](#schema-event)[] | Most recent events, newest first |

### POST `/api/events/test-filter`

Count recent events matching a filter

**Parameters**

| name | in | type | required | description |
| --- | --- | --- | --- | --- |
| `limit` | query | integer | no | How many recent events to test (default 1000); the body field `limit` takes precedence |

**Request body** (required)

Media type `application/json`: [TestFilterRequest](#schema-testfilterrequest)

Example `text` (Filter as text):

```json
{
  "filter": "alert.severity >= error"
}
```

Example `tree` (Filter as JSON tree):

```json
{
  "filter": {
    "type": "cmp",
    "field": "payload.desk",
    "op": "=",
    "value": "rates"
  },
  "limit": 100
}
```

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `application/json` | [TestFilterResponse](#schema-testfilterresponse) | Number of recent events matching the filter |
| 400 | `application/json` | [Error](#schema-error) | Bad request (invalid id, body, filter or parameter) |
| 413 | `application/json` | [Error](#schema-error) | Payload too large |

## filters

### POST `/api/filters/format`

Render a filter tree back to text

**Request body** (required)

Media type `application/json`: [FilterFormatRequest](#schema-filterformatrequest)

Example `tree` (Render a tree):

```json
{
  "tree": {
    "type": "and",
    "children": [
      {
        "type": "cmp",
        "field": "alert.severity",
        "op": "=",
        "value": "critical"
      },
      {
        "type": "in",
        "field": "alert.environment",
        "values": [
          "prod",
          "staging"
        ]
      }
    ]
  }
}
```

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `application/json` | [FilterFormatResponse](#schema-filterformatresponse) | The filter as text |
| 400 | `application/json` | [Error](#schema-error) | Bad request (invalid id, body, filter or parameter) |

### POST `/api/filters/parse`

Parse and validate a filter text; returns the JSON tree or an error with position

**Request body** (required)

Media type `application/json`: [FilterTextRequest](#schema-filtertextrequest)

Example `text` (Parse a filter):

```json
{
  "text": "alert.severity = critical AND alert.source = payments-api"
}
```

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `application/json` | [FilterParseResponse](#schema-filterparseresponse) | The parsed filter tree |
| 400 | `application/json` | [Error](#schema-error) | Bad request (invalid id, body, filter or parameter) |

### GET `/api/filters/suggest`

Autocomplete field names, operators and values

**Parameters**

| name | in | type | required | description |
| --- | --- | --- | --- | --- |
| `text` | query | string | no | Filter text typed so far |
| `cursor` | query | integer | no | Caret position in `text` (default: end of text) |

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `application/json` | string[] | Completions for the caret position |

### GET `/api/people/{id}/starred-filters`

List a person's starred filters

**Parameters**

| name | in | type | required | description |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes |  |

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `application/json` | [StarredFilter](#schema-starredfilter)[] | The person's starred filters (empty list when none) |
| 400 | `application/json` | [Error](#schema-error) | Bad request (invalid id, body, filter or parameter) |
| 404 | `application/json` | [Error](#schema-error) | Not found |
| 503 | `application/json` | [Error](#schema-error) | Dependency or component not configured |

### PUT `/api/people/{id}/starred-filters`

Replace a person's starred filters

**Parameters**

| name | in | type | required | description |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes |  |

**Request body** (required)

personId is optional but must match the path when present; each filter must be a JSON filter tree.

Media type `application/json`: [StarredFilter](#schema-starredfilter)[]

Example `anna` (Two starred filters (path id anna)):

```json
[
  {
    "id": "critical",
    "name": "Critical only",
    "filter": {
      "type": "cmp",
      "field": "alert.severity",
      "op": "=",
      "value": "critical"
    }
  },
  {
    "id": "prod-errors",
    "name": "Prod errors and above",
    "filter": {
      "type": "and",
      "children": [
        {
          "type": "cmp",
          "field": "alert.environment",
          "op": "=",
          "value": "prod"
        },
        {
          "type": "cmp",
          "field": "alert.severity",
          "op": ">=",
          "value": "error"
        }
      ]
    }
  }
]
```

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `application/json` | [StarredFilter](#schema-starredfilter)[] | The stored starred filters |
| 400 | `application/json` | [Error](#schema-error) | Bad request (invalid id, body, filter or parameter) |
| 404 | `application/json` | [Error](#schema-error) | Not found |
| 413 | `application/json` | [Error](#schema-error) | Payload too large |
| 503 | `application/json` | [Error](#schema-error) | Dependency or component not configured |

## groups

### GET `/api/groups`

List groups

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `application/json` | [Group](#schema-group)[] | All groups |
| 503 | `application/json` | [Error](#schema-error) | Dependency or component not configured |

### POST `/api/groups`

Create a Group

**Request body** (required)

The id must be unique; "import", "export" and "test" are reserved ids.

Media type `application/json`: [Group](#schema-group)

Example `ratesDesk` (Rates desk):

```json
{
  "id": "rates-desk",
  "name": "Rates desk",
  "memberIds": [
    "tomasz",
    "anna"
  ]
}
```

Example `pricingTeam` (Pricing team):

```json
{
  "id": "pricing-team",
  "name": "Pricing team",
  "memberIds": [
    "ewa"
  ]
}
```

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 201 | `application/json` | [Group](#schema-group) | The created Group (echo of the request body) |
| 400 | `application/json` | [Error](#schema-error) | Bad request (invalid id, body, filter or parameter) |
| 409 | `application/json` | [Error](#schema-error) | Conflict with the current state |
| 413 | `application/json` | [Error](#schema-error) | Payload too large |
| 503 | `application/json` | [Error](#schema-error) | Dependency or component not configured |

### GET `/api/groups/{id}`

Get a Group

**Parameters**

| name | in | type | required | description |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes |  |

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `application/json` | [Group](#schema-group) | The Group |
| 400 | `application/json` | [Error](#schema-error) | Bad request (invalid id, body, filter or parameter) |
| 404 | `application/json` | [Error](#schema-error) | Not found |
| 503 | `application/json` | [Error](#schema-error) | Dependency or component not configured |

### PUT `/api/groups/{id}`

Replace a Group

**Parameters**

| name | in | type | required | description |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes |  |

**Request body** (required)

The id in the body must equal the id in the path.

Media type `application/json`: [Group](#schema-group)

Example `ratesDesk` (Add a member (path id rates-desk)):

```json
{
  "id": "rates-desk",
  "name": "Rates desk",
  "memberIds": [
    "tomasz",
    "anna",
    "ewa"
  ]
}
```

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `application/json` | [Group](#schema-group) | The replaced Group |
| 400 | `application/json` | [Error](#schema-error) | Bad request (invalid id, body, filter or parameter) |
| 404 | `application/json` | [Error](#schema-error) | Not found |
| 413 | `application/json` | [Error](#schema-error) | Payload too large |
| 503 | `application/json` | [Error](#schema-error) | Dependency or component not configured |

### DELETE `/api/groups/{id}`

Delete a Group

**Parameters**

| name | in | type | required | description |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes |  |

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 204 |  |  | Group deleted |
| 400 | `application/json` | [Error](#schema-error) | Bad request (invalid id, body, filter or parameter) |
| 404 | `application/json` | [Error](#schema-error) | Not found |
| 503 | `application/json` | [Error](#schema-error) | Dependency or component not configured |

## ingest

### POST `/ingest/{sourceId}`

Ingest one JSON object, a JSON array or NDJSON into an http source

**Parameters**

| name | in | type | required | description |
| --- | --- | --- | --- | --- |
| `sourceId` | path | string | yes |  |

**Request body** (required)

One JSON object, a JSON array of objects, or NDJSON (one object per line).

Media type `application/json`: [JsonObject](#schema-jsonobject) \| [JsonObject](#schema-jsonobject)[]

Example `workflowFailed` (One WORKFLOW_FAILED event (GIVEN_SPEC Appendix A); use sourceId demo-http):

```json
{
  "type": "WORKFLOW_FAILED",
  "workflowId": "WF-20261023-00042",
  "workflowName": "order-settlement",
  "step": "validate-counterparty",
  "severity": "ERROR",
  "environment": "prod",
  "timestamp": "2026-10-23T09:14:02.331Z",
  "error": {
    "code": "TIMEOUT",
    "message": "Counterparty service did not respond in 5000 ms"
  }
}
```

Example `tradeRejected` (A JSON array with one trade.rejected event):

```json
[
  {
    "meta": {
      "schema": "trade.rejected.v2",
      "producer": "trade-gateway",
      "ts": 1792833245000
    },
    "payload": {
      "tradeId": "T-998877",
      "desk": "rates",
      "notional": 25000000,
      "currency": "EUR",
      "reason": "LIMIT_BREACH"
    }
  }
]
```

Media type `application/x-ndjson`: string

Example `ndjson` (NDJSON: two events, one per line):

```
{"type":"WORKFLOW_FAILED","workflowId":"WF-20261023-00042","workflowName":"order-settlement","step":"validate-counterparty","severity":"ERROR","environment":"prod","timestamp":"2026-10-23T09:14:02.331Z","error":{"code":"TIMEOUT","message":"Counterparty service did not respond in 5000 ms"}}
{"type":"WORKFLOW_FAILED","workflowId":"WF-20261023-00042","workflowName":"order-settlement","step":"reserve-funds","severity":"ERROR","environment":"prod","timestamp":"2026-10-23T09:14:02.331Z","error":{"code":"TIMEOUT","message":"Counterparty service did not respond in 5000 ms"}}
```

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 202 | `application/json` | [IngestResult](#schema-ingestresult) | Messages accepted for processing |
| 400 | `application/json` | [Error](#schema-error) | Bad request (invalid id, body, filter or parameter) |
| 404 | `application/json` | [Error](#schema-error) | Not found |
| 413 | `application/json` | [Error](#schema-error) | Payload too large |
| 500 | `application/json` | [Error](#schema-error) | Internal error |

## people

### GET `/api/people`

List people

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `application/json` | [Person](#schema-person)[] | All people |
| 503 | `application/json` | [Error](#schema-error) | Dependency or component not configured |

### POST `/api/people`

Create a Person

**Request body** (required)

The id must be unique; "import", "export" and "test" are reserved ids.

Media type `application/json`: [Person](#schema-person)

Example `anna` (Anna):

```json
{
  "id": "anna",
  "name": "Anna Kowalska",
  "role": "Payments lead",
  "canCreateRules": true,
  "ntfyTopic": "alerting-anna"
}
```

Example `ewa` (Ewa):

```json
{
  "id": "ewa",
  "name": "Ewa Mazur",
  "role": "Pricing engineer",
  "canCreateRules": false
}
```

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 201 | `application/json` | [Person](#schema-person) | The created Person (echo of the request body) |
| 400 | `application/json` | [Error](#schema-error) | Bad request (invalid id, body, filter or parameter) |
| 409 | `application/json` | [Error](#schema-error) | Conflict with the current state |
| 413 | `application/json` | [Error](#schema-error) | Payload too large |
| 503 | `application/json` | [Error](#schema-error) | Dependency or component not configured |

### GET `/api/people/{id}`

Get a Person

**Parameters**

| name | in | type | required | description |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes |  |

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `application/json` | [Person](#schema-person) | The Person |
| 400 | `application/json` | [Error](#schema-error) | Bad request (invalid id, body, filter or parameter) |
| 404 | `application/json` | [Error](#schema-error) | Not found |
| 503 | `application/json` | [Error](#schema-error) | Dependency or component not configured |

### PUT `/api/people/{id}`

Replace a Person

**Parameters**

| name | in | type | required | description |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes |  |

**Request body** (required)

The id in the body must equal the id in the path.

Media type `application/json`: [Person](#schema-person)

Example `anna` (Change Anna's role (path id anna)):

```json
{
  "id": "anna",
  "name": "Anna Kowalska",
  "role": "Head of payments",
  "canCreateRules": true,
  "ntfyTopic": "alerting-anna"
}
```

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `application/json` | [Person](#schema-person) | The replaced Person |
| 400 | `application/json` | [Error](#schema-error) | Bad request (invalid id, body, filter or parameter) |
| 404 | `application/json` | [Error](#schema-error) | Not found |
| 413 | `application/json` | [Error](#schema-error) | Payload too large |
| 503 | `application/json` | [Error](#schema-error) | Dependency or component not configured |

### DELETE `/api/people/{id}`

Delete a Person

**Parameters**

| name | in | type | required | description |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes |  |

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 204 |  |  | Person deleted |
| 400 | `application/json` | [Error](#schema-error) | Bad request (invalid id, body, filter or parameter) |
| 404 | `application/json` | [Error](#schema-error) | Not found |
| 503 | `application/json` | [Error](#schema-error) | Dependency or component not configured |

## preferences

### GET `/api/groups/{id}/preferences`

Get a group's notification preferences

**Parameters**

| name | in | type | required | description |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes |  |

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `application/json` | [Preference](#schema-preference) | Stored preference, or an empty one (rules: []) when none is stored |
| 400 | `application/json` | [Error](#schema-error) | Bad request (invalid id, body, filter or parameter) |
| 404 | `application/json` | [Error](#schema-error) | Not found |
| 503 | `application/json` | [Error](#schema-error) | Dependency or component not configured |

### PUT `/api/groups/{id}/preferences`

Set a group's notification preferences

**Parameters**

| name | in | type | required | description |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes |  |

**Request body** (required)

ownerType/ownerId are optional but, when present, must match the group in the path.

Media type `application/json`: [Preference](#schema-preference)

Example `ratesDesk` (Rates desk: warnings and above to ui (path id rates-desk)):

```json
{
  "ownerType": "group",
  "ownerId": "rates-desk",
  "rules": [
    {
      "when": {
        "type": "cmp",
        "field": "alert.severity",
        "op": ">=",
        "value": "warning"
      },
      "channels": [
        "ui"
      ]
    }
  ]
}
```

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `application/json` | [Preference](#schema-preference) | The stored preference |
| 400 | `application/json` | [Error](#schema-error) | Bad request (invalid id, body, filter or parameter) |
| 404 | `application/json` | [Error](#schema-error) | Not found |
| 413 | `application/json` | [Error](#schema-error) | Payload too large |
| 503 | `application/json` | [Error](#schema-error) | Dependency or component not configured |

### GET `/api/people/{id}/preferences`

Get a person's notification preferences

**Parameters**

| name | in | type | required | description |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes |  |

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `application/json` | [Preference](#schema-preference) | Stored preference, or an empty one (rules: []) when none is stored |
| 400 | `application/json` | [Error](#schema-error) | Bad request (invalid id, body, filter or parameter) |
| 404 | `application/json` | [Error](#schema-error) | Not found |
| 503 | `application/json` | [Error](#schema-error) | Dependency or component not configured |

### PUT `/api/people/{id}/preferences`

Set a person's notification preferences

**Parameters**

| name | in | type | required | description |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes |  |

**Request body** (required)

ownerType/ownerId are optional but, when present, must match the person in the path.

Media type `application/json`: [Preference](#schema-preference)

Example `anna` (Anna: critical also to ntfy, quiet hours 20:00-08:00 (path id anna)):

```json
{
  "ownerType": "person",
  "ownerId": "anna",
  "rules": [
    {
      "when": {
        "type": "cmp",
        "field": "alert.severity",
        "op": "=",
        "value": "critical"
      },
      "channels": [
        "ui",
        "ntfy"
      ]
    }
  ],
  "quietHours": {
    "from": "20:00",
    "to": "08:00",
    "timezone": "Europe/Warsaw",
    "allowChannels": [
      "ui"
    ]
  }
}
```

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `application/json` | [Preference](#schema-preference) | The stored preference |
| 400 | `application/json` | [Error](#schema-error) | Bad request (invalid id, body, filter or parameter) |
| 404 | `application/json` | [Error](#schema-error) | Not found |
| 413 | `application/json` | [Error](#schema-error) | Payload too large |
| 503 | `application/json` | [Error](#schema-error) | Dependency or component not configured |

## rules

### GET `/api/rules`

List rules

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `application/json` | [Rule](#schema-rule)[] | All rules |
| 503 | `application/json` | [Error](#schema-error) | Dependency or component not configured |

### POST `/api/rules`

Create a Rule

**Request body** (required)

The id must be unique; "import", "export" and "test" are reserved ids.

Media type `application/json`: [Rule](#schema-rule)

Example `ratesTradeRejected` (Team Rates (filter as text)):

```json
{
  "id": "rates-trade-rejected",
  "name": "Team Rates",
  "enabled": true,
  "when": "alert.schema matches trade.rejected.* AND payload.desk = rates AND payload.notional > 10000000",
  "who": [
    {
      "recipients": [
        {
          "type": "group",
          "id": "rates-desk"
        }
      ],
      "force": [
        "ntfy",
        "ui"
      ]
    }
  ],
  "looks": {
    "titleTemplate": "Rejected {{payload.currency}} {{payload.notional}} - {{payload.reason}}",
    "fields": [
      "payload.tradeId",
      "payload.desk",
      "payload.notional"
    ]
  },
  "createdAt": "2026-11-01T00:00:00Z",
  "updatedAt": "2026-11-01T00:00:00Z"
}
```

Example `settlements` (Team Settlements):

```json
{
  "id": "settlements-workflow-failed",
  "name": "Team Settlements",
  "enabled": true,
  "when": "type = WORKFLOW_FAILED AND workflowName = order-settlement AND environment = prod",
  "who": [
    {
      "recipients": [
        {
          "type": "group",
          "id": "settlements-oncall"
        }
      ],
      "force": [
        "ntfy",
        "ui"
      ]
    }
  ],
  "looks": {
    "titleTemplate": "Settlement failed at {{step}}",
    "fields": [
      "step",
      "error.message"
    ],
    "colour": "red"
  },
  "createdAt": "2026-11-01T00:00:00Z",
  "updatedAt": "2026-11-01T00:00:00Z"
}
```

Example `annaCritical` (Anna personal rule (filter as JSON tree)):

```json
{
  "id": "anna-payments-critical",
  "name": "Anna (personal)",
  "enabled": true,
  "when": {
    "type": "and",
    "children": [
      {
        "type": "cmp",
        "field": "alert.severity",
        "op": "=",
        "value": "critical"
      },
      {
        "type": "cmp",
        "field": "alert.source",
        "op": "=",
        "value": "payments-api"
      }
    ]
  },
  "who": [
    {
      "recipients": [
        {
          "type": "person",
          "id": "anna"
        }
      ]
    }
  ],
  "looks": {
    "titleTemplate": "{{alert.title}}",
    "fields": [
      "alert.source"
    ]
  },
  "createdAt": "2026-11-01T00:00:00Z",
  "updatedAt": "2026-11-01T00:00:00Z"
}
```

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 201 | `application/json` | [Rule](#schema-rule) | The created Rule (echo of the request body) |
| 400 | `application/json` | [Error](#schema-error) | Bad request (invalid id, body, filter or parameter) |
| 409 | `application/json` | [Error](#schema-error) | Conflict with the current state |
| 413 | `application/json` | [Error](#schema-error) | Payload too large |
| 503 | `application/json` | [Error](#schema-error) | Dependency or component not configured |

### GET `/api/rules/{id}`

Get a Rule

**Parameters**

| name | in | type | required | description |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes |  |

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `application/json` | [Rule](#schema-rule) | The Rule |
| 400 | `application/json` | [Error](#schema-error) | Bad request (invalid id, body, filter or parameter) |
| 404 | `application/json` | [Error](#schema-error) | Not found |
| 503 | `application/json` | [Error](#schema-error) | Dependency or component not configured |

### PUT `/api/rules/{id}`

Replace a Rule

**Parameters**

| name | in | type | required | description |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes |  |

**Request body** (required)

The id in the body must equal the id in the path.

Media type `application/json`: [Rule](#schema-rule)

Example `rates` (Disable Team Rates (path id rates-trade-rejected)):

```json
{
  "id": "rates-trade-rejected",
  "name": "Team Rates",
  "enabled": false,
  "when": "alert.schema matches trade.rejected.* AND payload.desk = rates AND payload.notional > 10000000",
  "who": [
    {
      "recipients": [
        {
          "type": "group",
          "id": "rates-desk"
        }
      ],
      "force": [
        "ntfy",
        "ui"
      ]
    }
  ],
  "looks": {
    "titleTemplate": "Rejected {{payload.currency}} {{payload.notional}} - {{payload.reason}}",
    "fields": [
      "payload.tradeId",
      "payload.desk",
      "payload.notional"
    ]
  },
  "createdAt": "2026-11-01T00:00:00Z",
  "updatedAt": "2026-11-01T00:00:00Z"
}
```

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `application/json` | [Rule](#schema-rule) | The replaced Rule |
| 400 | `application/json` | [Error](#schema-error) | Bad request (invalid id, body, filter or parameter) |
| 404 | `application/json` | [Error](#schema-error) | Not found |
| 413 | `application/json` | [Error](#schema-error) | Payload too large |
| 503 | `application/json` | [Error](#schema-error) | Dependency or component not configured |

### DELETE `/api/rules/{id}`

Delete a Rule

**Parameters**

| name | in | type | required | description |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes |  |

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 204 |  |  | Rule deleted |
| 400 | `application/json` | [Error](#schema-error) | Bad request (invalid id, body, filter or parameter) |
| 404 | `application/json` | [Error](#schema-error) | Not found |
| 503 | `application/json` | [Error](#schema-error) | Dependency or component not configured |

## runbooks

### GET `/api/alerts/{id}/runbook-runs`

Runbook run state per step of an alert

**Parameters**

| name | in | type | required | description |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes |  |

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `application/json` | [RunbookRun](#schema-runbookrun)[] | Runs of matching runbooks for the alert |
| 400 | `application/json` | [Error](#schema-error) | Bad request (invalid id, body, filter or parameter) |

### POST `/api/alerts/{id}/runbook-steps/{stepIndex}/approve`

Approve a runbook step awaiting approval

**Parameters**

| name | in | type | required | description |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes |  |
| `stepIndex` | path | integer | yes | Zero-based index of the step |
| `runbookId` | query | string | no | Runbook id (alternative to the body field) |
| `actor` | query | string | no | Approver (alternative to the body field) |

**Request body**

Media type `application/json`: [ApproveStepRequest](#schema-approvesteprequest)

Example `approve` (Approve the escalation step (step index 2 of settlement-timeout)):

```json
{
  "actor": "marek",
  "runbookId": "settlement-timeout",
  "decision": "approve"
}
```

Example `skip` (Skip the step):

```json
{
  "actor": "marek",
  "runbookId": "settlement-timeout",
  "decision": "skip"
}
```

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `application/json` | [RunbookRun](#schema-runbookrun) | The run after the step was approved or skipped |
| 202 | `application/json` | [RunbookRun](#schema-runbookrun) | Approved; the continuation is still running |
| 400 | `application/json` | [Error](#schema-error) | Bad request (invalid id, body, filter or parameter) |
| 404 | `application/json` | [Error](#schema-error) | Not found |
| 409 | `application/json` | [Error](#schema-error) | Conflict with the current state |
| 413 | `application/json` | [Error](#schema-error) | Payload too large |

### GET `/api/approvals`

Pending runbook step approvals

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `application/json` | [PendingApproval](#schema-pendingapproval)[] | Steps awaiting approval |

### GET `/api/runbooks`

List runbooks

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `application/json` | [Runbook](#schema-runbook)[] | All runbooks |
| 503 | `application/json` | [Error](#schema-error) | Dependency or component not configured |

### POST `/api/runbooks`

Create a Runbook

**Request body** (required)

The id must be unique; "import", "export" and "test" are reserved ids.

Media type `application/json`: [Runbook](#schema-runbook)

Example `text` (Text runbook):

```json
{
  "id": "payments-high-error-rate",
  "name": "Payments high error rate",
  "type": "text",
  "matches": "alertname = HighErrorRate AND labels.service = payments-api",
  "content": "# {{alertname}} on {{labels.service}}\nRegion: {{labels.region}} - {{annotations.summary}}\n\n1. Open the payments dashboard and check if errors are in one region only.\n2. If one region: fail traffic over to the other region (needs approval from the team lead).\n3. If all regions: check the last deployment and roll it back.\n"
}
```

Example `automation` (Automation runbook with an approval gate):

```json
{
  "id": "settlement-timeout",
  "name": "Settlement workflow timeout",
  "type": "automation",
  "matches": "type = WORKFLOW_FAILED AND error.code = TIMEOUT",
  "steps": [
    {
      "name": "Check counterparty-service health",
      "action": "http",
      "method": "GET",
      "url": "http://demo-service:4100/health",
      "approval": "none"
    },
    {
      "name": "Retry workflow {{workflowId}}",
      "action": "http",
      "method": "POST",
      "url": "http://demo-service:4100/workflows/{{workflowId}}/retry",
      "headers": {
        "content-type": "application/json"
      },
      "body": "{\"workflowId\":\"{{workflowId}}\",\"reason\":\"{{error.code}}\"}",
      "approval": "none"
    },
    {
      "name": "Escalate to counterparty-support",
      "action": "escalate",
      "group": "counterparty-support",
      "approval": "required"
    }
  ]
}
```

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 201 | `application/json` | [Runbook](#schema-runbook) | The created Runbook (echo of the request body) |
| 400 | `application/json` | [Error](#schema-error) | Bad request (invalid id, body, filter or parameter) |
| 409 | `application/json` | [Error](#schema-error) | Conflict with the current state |
| 413 | `application/json` | [Error](#schema-error) | Payload too large |
| 503 | `application/json` | [Error](#schema-error) | Dependency or component not configured |

### GET `/api/runbooks/{id}`

Get a Runbook

**Parameters**

| name | in | type | required | description |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes |  |

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `application/json` | [Runbook](#schema-runbook) | The Runbook |
| 400 | `application/json` | [Error](#schema-error) | Bad request (invalid id, body, filter or parameter) |
| 404 | `application/json` | [Error](#schema-error) | Not found |
| 503 | `application/json` | [Error](#schema-error) | Dependency or component not configured |

### PUT `/api/runbooks/{id}`

Replace a Runbook

**Parameters**

| name | in | type | required | description |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes |  |

**Request body** (required)

The id in the body must equal the id in the path.

Media type `application/json`: [Runbook](#schema-runbook)

Example `text` (Rename (path id payments-high-error-rate)):

```json
{
  "id": "payments-high-error-rate",
  "name": "Payments high error rate (v2)",
  "type": "text",
  "matches": "alertname = HighErrorRate AND labels.service = payments-api",
  "content": "# {{alertname}} on {{labels.service}}\nRegion: {{labels.region}} - {{annotations.summary}}\n\n1. Open the payments dashboard and check if errors are in one region only.\n2. If one region: fail traffic over to the other region (needs approval from the team lead).\n3. If all regions: check the last deployment and roll it back.\n"
}
```

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `application/json` | [Runbook](#schema-runbook) | The replaced Runbook |
| 400 | `application/json` | [Error](#schema-error) | Bad request (invalid id, body, filter or parameter) |
| 404 | `application/json` | [Error](#schema-error) | Not found |
| 413 | `application/json` | [Error](#schema-error) | Payload too large |
| 503 | `application/json` | [Error](#schema-error) | Dependency or component not configured |

### DELETE `/api/runbooks/{id}`

Delete a Runbook

**Parameters**

| name | in | type | required | description |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes |  |

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 204 |  |  | Runbook deleted |
| 400 | `application/json` | [Error](#schema-error) | Bad request (invalid id, body, filter or parameter) |
| 404 | `application/json` | [Error](#schema-error) | Not found |
| 503 | `application/json` | [Error](#schema-error) | Dependency or component not configured |

## schemas

### GET `/api/schemas`

List schemas

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `application/json` | [Schema](#schema-schema)[] | All schemas |
| 503 | `application/json` | [Error](#schema-error) | Dependency or component not configured |

### POST `/api/schemas`

Create a Schema

**Request body** (required)

The id must be unique; "import", "export" and "test" are reserved ids.

Media type `application/json`: [Schema](#schema-schema)

Example `workflowFailed` (Workflow failed schema):

```json
{
  "id": "schema-workflow-failed",
  "name": "Workflow failed",
  "match": "type = WORKFLOW_FAILED",
  "mapping": {
    "severity": {
      "kind": "path",
      "path": "severity",
      "valueMap": {
        "ERROR": "error",
        "WARN": "warning",
        "CRITICAL": "critical"
      },
      "default": "error"
    },
    "title": {
      "kind": "template",
      "template": "{{workflowName}} failed at {{step}}"
    },
    "source": {
      "kind": "path",
      "path": "workflowName"
    },
    "environment": {
      "kind": "path",
      "path": "environment"
    },
    "dedupKey": {
      "kind": "template",
      "template": "{{workflowName}}-{{step}}"
    },
    "sourceStatus": {
      "kind": "constant",
      "value": "firing"
    },
    "occurredAt": {
      "kind": "path",
      "path": "timestamp"
    },
    "type": {
      "kind": "path",
      "path": "type"
    },
    "message": {
      "kind": "path",
      "path": "error.message"
    },
    "entity": {
      "kind": "path",
      "path": "workflowId"
    }
  }
}
```

Example `tradeRejected` (Trade rejected schema):

```json
{
  "id": "schema-trade-rejected",
  "name": "Trade rejected",
  "match": "meta.schema matches \"trade.rejected.*\"",
  "mapping": {
    "severity": {
      "kind": "constant",
      "value": "info"
    },
    "title": {
      "kind": "template",
      "template": "Rejected {{payload.currency}} {{payload.notional}} - {{payload.reason}}"
    },
    "source": {
      "kind": "path",
      "path": "meta.producer"
    },
    "environment": {
      "kind": "constant",
      "value": "prod"
    },
    "dedupKey": {
      "kind": "path",
      "path": "payload.tradeId"
    },
    "occurredAt": {
      "kind": "path",
      "path": "meta.ts"
    }
  }
}
```

Example `metricBreach` (Prometheus style metric breach):

```json
{
  "id": "schema-metric-breach",
  "name": "Metric threshold breach (Prometheus/Alertmanager style)",
  "match": "alertname matches * AND labels.service matches * AND startsAt matches *",
  "mapping": {
    "severity": {
      "kind": "path",
      "path": "labels.severity"
    },
    "title": {
      "kind": "template",
      "template": "{{alertname}} on {{labels.service}}"
    },
    "source": {
      "kind": "path",
      "path": "labels.service"
    },
    "environment": {
      "kind": "path",
      "path": "labels.environment",
      "default": "prod"
    },
    "dedupKey": {
      "kind": "template",
      "template": "{{alertname}}-{{labels.service}}"
    },
    "occurredAt": {
      "kind": "path",
      "path": "startsAt"
    }
  }
}
```

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 201 | `application/json` | [Schema](#schema-schema) | The created Schema (echo of the request body) |
| 400 | `application/json` | [Error](#schema-error) | Bad request (invalid id, body, filter or parameter) |
| 409 | `application/json` | [Error](#schema-error) | Conflict with the current state |
| 413 | `application/json` | [Error](#schema-error) | Payload too large |
| 503 | `application/json` | [Error](#schema-error) | Dependency or component not configured |

### POST `/api/schemas/test`

**NOT IMPLEMENTED YET** (issue #108): the server currently answers 404.

Try a schema/mapping against a pasted sample; returns the mapped common fields

**Request body** (required)

Media type `application/json`: [SchemaTestRequest](#schema-schematestrequest)

Example `workflowFailed` (Try the workflow schema on the Appendix A sample):

```json
{
  "schema": {
    "id": "schema-workflow-failed",
    "name": "Workflow failed",
    "match": "type = WORKFLOW_FAILED",
    "mapping": {
      "severity": {
        "kind": "path",
        "path": "severity",
        "valueMap": {
          "ERROR": "error",
          "WARN": "warning",
          "CRITICAL": "critical"
        },
        "default": "error"
      },
      "title": {
        "kind": "template",
        "template": "{{workflowName}} failed at {{step}}"
      },
      "source": {
        "kind": "path",
        "path": "workflowName"
      },
      "environment": {
        "kind": "path",
        "path": "environment"
      },
      "dedupKey": {
        "kind": "template",
        "template": "{{workflowName}}-{{step}}"
      },
      "sourceStatus": {
        "kind": "constant",
        "value": "firing"
      },
      "occurredAt": {
        "kind": "path",
        "path": "timestamp"
      },
      "type": {
        "kind": "path",
        "path": "type"
      },
      "message": {
        "kind": "path",
        "path": "error.message"
      },
      "entity": {
        "kind": "path",
        "path": "workflowId"
      }
    }
  },
  "sample": {
    "type": "WORKFLOW_FAILED",
    "workflowId": "WF-20261023-00042",
    "workflowName": "order-settlement",
    "step": "validate-counterparty",
    "severity": "ERROR",
    "environment": "prod",
    "timestamp": "2026-10-23T09:14:02.331Z",
    "error": {
      "code": "TIMEOUT",
      "message": "Counterparty service did not respond in 5000 ms"
    }
  }
}
```

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `application/json` | [SchemaTestResponse](#schema-schematestresponse) | Whether the sample matched and the mapped common fields |
| 400 | `application/json` | [Error](#schema-error) | Bad request (invalid id, body, filter or parameter) |

### GET `/api/schemas/{id}`

Get a Schema

**Parameters**

| name | in | type | required | description |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes |  |

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `application/json` | [Schema](#schema-schema) | The Schema |
| 400 | `application/json` | [Error](#schema-error) | Bad request (invalid id, body, filter or parameter) |
| 404 | `application/json` | [Error](#schema-error) | Not found |
| 503 | `application/json` | [Error](#schema-error) | Dependency or component not configured |

### PUT `/api/schemas/{id}`

Replace a Schema

**Parameters**

| name | in | type | required | description |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes |  |

**Request body** (required)

The id in the body must equal the id in the path.

Media type `application/json`: [Schema](#schema-schema)

Example `workflowFailed` (Rename (path id schema-workflow-failed)):

```json
{
  "id": "schema-workflow-failed",
  "name": "Workflow failed (v2)",
  "match": "type = WORKFLOW_FAILED",
  "mapping": {
    "severity": {
      "kind": "path",
      "path": "severity",
      "valueMap": {
        "ERROR": "error",
        "WARN": "warning",
        "CRITICAL": "critical"
      },
      "default": "error"
    },
    "title": {
      "kind": "template",
      "template": "{{workflowName}} failed at {{step}}"
    },
    "source": {
      "kind": "path",
      "path": "workflowName"
    },
    "environment": {
      "kind": "path",
      "path": "environment"
    },
    "dedupKey": {
      "kind": "template",
      "template": "{{workflowName}}-{{step}}"
    },
    "sourceStatus": {
      "kind": "constant",
      "value": "firing"
    },
    "occurredAt": {
      "kind": "path",
      "path": "timestamp"
    },
    "type": {
      "kind": "path",
      "path": "type"
    },
    "message": {
      "kind": "path",
      "path": "error.message"
    },
    "entity": {
      "kind": "path",
      "path": "workflowId"
    }
  }
}
```

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `application/json` | [Schema](#schema-schema) | The replaced Schema |
| 400 | `application/json` | [Error](#schema-error) | Bad request (invalid id, body, filter or parameter) |
| 404 | `application/json` | [Error](#schema-error) | Not found |
| 413 | `application/json` | [Error](#schema-error) | Payload too large |
| 503 | `application/json` | [Error](#schema-error) | Dependency or component not configured |

### DELETE `/api/schemas/{id}`

Delete a Schema

**Parameters**

| name | in | type | required | description |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes |  |

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 204 |  |  | Schema deleted |
| 400 | `application/json` | [Error](#schema-error) | Bad request (invalid id, body, filter or parameter) |
| 404 | `application/json` | [Error](#schema-error) | Not found |
| 503 | `application/json` | [Error](#schema-error) | Dependency or component not configured |

## sources

### GET `/api/source-types`

Registered source plugin types with their config JSON Schemas, plus the parser config schema

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `application/json` | [SourceTypesResponse](#schema-sourcetypesresponse) | Source plugin types and the parser config schema |

### GET `/api/sources`

List sources

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `application/json` | [Source](#schema-source)[] | All sources |
| 503 | `application/json` | [Error](#schema-error) | Dependency or component not configured |

### POST `/api/sources`

Create a Source

**Request body** (required)

The id must be unique; "import", "export" and "test" are reserved ids.

Media type `application/json`: [Source](#schema-source)

Example `http` (HTTP ingest source):

```json
{
  "id": "demo-http",
  "name": "Demo (HTTP)",
  "enabled": true,
  "parser": {
    "type": "json"
  },
  "type": "http",
  "config": {}
}
```

Example `fileTail` (File-tail source):

```json
{
  "id": "demo-logs",
  "name": "Demo (log files)",
  "enabled": true,
  "parser": {
    "type": "json"
  },
  "type": "file_tail",
  "config": {
    "path": "/tmp/demo-logs/*.log"
  }
}
```

Example `redisStream` (Redis stream source):

```json
{
  "id": "demo-stream",
  "name": "Demo (Redis stream)",
  "enabled": true,
  "parser": {
    "type": "json"
  },
  "type": "redis_stream",
  "config": {
    "stream": "demo:events",
    "consumerGroup": "alerting"
  }
}
```

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 201 | `application/json` | [Source](#schema-source) | The created Source (echo of the request body) |
| 400 | `application/json` | [Error](#schema-error) | Bad request (invalid id, body, filter or parameter) |
| 409 | `application/json` | [Error](#schema-error) | Conflict with the current state |
| 413 | `application/json` | [Error](#schema-error) | Payload too large |
| 503 | `application/json` | [Error](#schema-error) | Dependency or component not configured |

### POST `/api/sources/test`

**NOT IMPLEMENTED YET** (issue #108): the server currently answers 404.

Try a parser on a sample line; returns the parsed fields

**Request body** (required)

Media type `application/json`: [SourceTestRequest](#schema-sourcetestrequest)

Example `json` (JSON parser on one line):

```json
{
  "parser": {
    "type": "json"
  },
  "sample": "{\"type\":\"WORKFLOW_FAILED\",\"workflowId\":\"WF-20261023-00042\",\"workflowName\":\"order-settlement\",\"step\":\"validate-counterparty\",\"severity\":\"ERROR\",\"environment\":\"prod\",\"timestamp\":\"2026-10-23T09:14:02.331Z\",\"error\":{\"code\":\"TIMEOUT\",\"message\":\"Counterparty service did not respond in 5000 ms\"}}"
}
```

Example `logfmt` (logfmt parser):

```json
{
  "parser": {
    "type": "logfmt"
  },
  "sample": "level=error msg=\"payment failed\" service=payments-api"
}
```

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `application/json` | [SourceTestResponse](#schema-sourcetestresponse) | The parsed fields |
| 400 | `application/json` | [Error](#schema-error) | Bad request (invalid id, body, filter or parameter) |

### GET `/api/sources/{id}`

Get a Source

**Parameters**

| name | in | type | required | description |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes |  |

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `application/json` | [Source](#schema-source) | The Source |
| 400 | `application/json` | [Error](#schema-error) | Bad request (invalid id, body, filter or parameter) |
| 404 | `application/json` | [Error](#schema-error) | Not found |
| 503 | `application/json` | [Error](#schema-error) | Dependency or component not configured |

### PUT `/api/sources/{id}`

Replace a Source

**Parameters**

| name | in | type | required | description |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes |  |

**Request body** (required)

The id in the body must equal the id in the path.

Media type `application/json`: [Source](#schema-source)

Example `http` (Rename the HTTP source (path id demo-http)):

```json
{
  "id": "demo-http",
  "name": "Demo (HTTP) renamed",
  "enabled": true,
  "parser": {
    "type": "json"
  },
  "type": "http",
  "config": {}
}
```

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `application/json` | [Source](#schema-source) | The replaced Source |
| 400 | `application/json` | [Error](#schema-error) | Bad request (invalid id, body, filter or parameter) |
| 404 | `application/json` | [Error](#schema-error) | Not found |
| 413 | `application/json` | [Error](#schema-error) | Payload too large |
| 503 | `application/json` | [Error](#schema-error) | Dependency or component not configured |

### DELETE `/api/sources/{id}`

Delete a Source

**Parameters**

| name | in | type | required | description |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes |  |

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 204 |  |  | Source deleted |
| 400 | `application/json` | [Error](#schema-error) | Bad request (invalid id, body, filter or parameter) |
| 404 | `application/json` | [Error](#schema-error) | Not found |
| 503 | `application/json` | [Error](#schema-error) | Dependency or component not configured |

### GET `/api/sources/{id}/preview`

**NOT IMPLEMENTED YET** (issue #108): the server currently answers 404.

Live preview of incoming raw and parsed messages (SSE)

**Parameters**

| name | in | type | required | description |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes |  |

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `text/event-stream` | string | Server-sent events: each `data:` line is JSON with the raw and parsed message |
| 404 | `application/json` | [Error](#schema-error) | Not found |

## stream

### GET `/api/stream`

Live push of new and updated alerts (SSE)

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `text/event-stream` | string | Server-sent events; each `data:` line is a JSON UiPush message |
| 503 | `application/json` | [Error](#schema-error) | Dependency or component not configured |

## suggestions

### POST `/api/alerts/{id}/suggestions`

Suggest a change (attached to the alert's rule)

**Parameters**

| name | in | type | required | description |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes |  |

**Request body** (required)

Media type `application/json`: [SuggestionRequest](#schema-suggestionrequest)

Example `text` (Suggest tuning the rule):

```json
{
  "text": "Only page the on-call after two consecutive timeouts.",
  "author": "julia"
}
```

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 201 | `application/json` | [Suggestion](#schema-suggestion) | The created suggestion |
| 400 | `application/json` | [Error](#schema-error) | Bad request (invalid id, body, filter or parameter) |
| 404 | `application/json` | [Error](#schema-error) | Not found |
| 413 | `application/json` | [Error](#schema-error) | Payload too large |

### GET `/api/rules/{id}/suggestions`

List suggestions for a rule

**Parameters**

| name | in | type | required | description |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes |  |
| `status` | query | "open" \| "accepted" \| "dismissed" | no | Only suggestions with this status |

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `application/json` | [Suggestion](#schema-suggestion)[] | Suggestions of the rule |
| 400 | `application/json` | [Error](#schema-error) | Bad request (invalid id, body, filter or parameter) |

### POST `/api/rules/{id}/suggestions`

Suggest a change to a rule

**Parameters**

| name | in | type | required | description |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes |  |

**Request body** (required)

Media type `application/json`: [SuggestionRequest](#schema-suggestionrequest)

Example `text` (Suggest a change to a rule (any rule id; the rule is not checked)):

```json
{
  "text": "Raise the notional threshold to 20M EUR.",
  "author": "tomasz"
}
```

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 201 | `application/json` | [Suggestion](#schema-suggestion) | The created suggestion |
| 400 | `application/json` | [Error](#schema-error) | Bad request (invalid id, body, filter or parameter) |
| 413 | `application/json` | [Error](#schema-error) | Payload too large |

### POST `/api/suggestions/{id}/accept`

Accept a suggestion

**Parameters**

| name | in | type | required | description |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes |  |

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `application/json` | [Suggestion](#schema-suggestion) | The accepted suggestion |
| 400 | `application/json` | [Error](#schema-error) | Bad request (invalid id, body, filter or parameter) |
| 404 | `application/json` | [Error](#schema-error) | Not found |
| 409 | `application/json` | [Error](#schema-error) | Conflict with the current state |

### POST `/api/suggestions/{id}/dismiss`

Dismiss a suggestion

**Parameters**

| name | in | type | required | description |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes |  |

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `application/json` | [Suggestion](#schema-suggestion) | The dismissed suggestion |
| 400 | `application/json` | [Error](#schema-error) | Bad request (invalid id, body, filter or parameter) |
| 404 | `application/json` | [Error](#schema-error) | Not found |
| 409 | `application/json` | [Error](#schema-error) | Conflict with the current state |

## system

### GET `/api/openapi.json`

This OpenAPI document

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `application/json` | object | This OpenAPI document |

### GET `/health`

Liveness and dependency check

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `application/json` | [Health](#schema-health) | Postgres and Redis are reachable |
| 503 | `application/json` | [Health](#schema-health) | A dependency check failed |

## yaml

### POST `/api/rules/import`

Import a rule from YAML

**Request body** (required)

A Rule as YAML text (same shape and validation as the JSON form).

Media type `application/yaml`: string

Example `yaml` (Rule as YAML):

```yaml
id: yaml-demo-rule
name: Team Settlements (YAML import)
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

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `application/json` | [Rule](#schema-rule) | The imported (upserted) rule |
| 400 | `application/json` | [Error](#schema-error) | Bad request (invalid id, body, filter or parameter) |
| 413 | `application/json` | [Error](#schema-error) | Payload too large |
| 503 | `application/json` | [Error](#schema-error) | Dependency or component not configured |

### GET `/api/rules/{id}/export`

Export a rule as YAML

**Parameters**

| name | in | type | required | description |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes |  |

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `application/yaml` | string | The rule as YAML text |
| 400 | `application/json` | [Error](#schema-error) | Bad request (invalid id, body, filter or parameter) |
| 404 | `application/json` | [Error](#schema-error) | Not found |
| 503 | `application/json` | [Error](#schema-error) | Dependency or component not configured |

### POST `/api/schemas/import`

Import a schema from YAML

**Request body** (required)

A Schema as YAML text (same shape and validation as the JSON form).

Media type `application/yaml`: string

Example `yaml` (Schema as YAML):

```yaml
id: schema-yaml-demo
name: Workflow failed (YAML import)
match: type = WORKFLOW_FAILED
mapping:
  severity: { kind: path, path: severity, valueMap: { ERROR: error, WARN: warning, CRITICAL: critical }, default: error }
  title: { kind: template, template: "{{workflowName}} failed at {{step}}" }
  source: { kind: path, path: workflowName }
  environment: { kind: path, path: environment }
  dedupKey: { kind: template, template: "{{workflowName}}-{{step}}" }
```

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `application/json` | [Schema](#schema-schema) | The imported (upserted) schema |
| 400 | `application/json` | [Error](#schema-error) | Bad request (invalid id, body, filter or parameter) |
| 413 | `application/json` | [Error](#schema-error) | Payload too large |
| 503 | `application/json` | [Error](#schema-error) | Dependency or component not configured |

### GET `/api/schemas/{id}/export`

Export a schema as YAML

**Parameters**

| name | in | type | required | description |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes |  |

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `application/yaml` | string | The schema as YAML text |
| 400 | `application/json` | [Error](#schema-error) | Bad request (invalid id, body, filter or parameter) |
| 404 | `application/json` | [Error](#schema-error) | Not found |
| 503 | `application/json` | [Error](#schema-error) | Dependency or component not configured |

### POST `/api/sources/import`

Import a source from YAML

**Request body** (required)

A Source as YAML text (same shape and validation as the JSON form).

Media type `application/yaml`: string

Example `yaml` (Source as YAML):

```yaml
id: demo-http-yaml
name: Demo (HTTP, YAML import)
enabled: true
parser: { type: json }
type: http
config: {}
```

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `application/json` | [Source](#schema-source) | The imported (upserted) source |
| 400 | `application/json` | [Error](#schema-error) | Bad request (invalid id, body, filter or parameter) |
| 413 | `application/json` | [Error](#schema-error) | Payload too large |
| 503 | `application/json` | [Error](#schema-error) | Dependency or component not configured |

### GET `/api/sources/{id}/export`

Export a source as YAML

**Parameters**

| name | in | type | required | description |
| --- | --- | --- | --- | --- |
| `id` | path | string | yes |  |

**Responses**

| status | media type | schema | description |
| --- | --- | --- | --- |
| 200 | `application/yaml` | string | The source as YAML text |
| 400 | `application/json` | [Error](#schema-error) | Bad request (invalid id, body, filter or parameter) |
| 404 | `application/json` | [Error](#schema-error) | Not found |
| 503 | `application/json` | [Error](#schema-error) | Dependency or component not configured |

## Schemas

<a id="schema-accountcreate"></a>

### AccountCreate

| name | type | required | description |
| --- | --- | --- | --- |
| `name` | string | yes |  |
| `role` | string \| null | no |  |

<a id="schema-alert"></a>

### Alert

| name | type | required | description |
| --- | --- | --- | --- |
| `id` | string | yes |  |
| `ruleId` | string | yes |  |
| `eventId` | string | yes |  |
| `schemaId` | string \| null | no |  |
| `dedupKey` | string | yes |  |
| `state` | [AlertState](#schema-alertstate) | yes |  |
| `severity` | [Severity](#schema-severity) | yes |  |
| `title` | string | yes |  |
| `body` | string \| null | no |  |
| `source` | string | yes |  |
| `environment` | string | yes |  |
| `count` | integer | yes |  |
| `firstSeen` | string | yes |  |
| `lastSeen` | string | yes |  |
| `acknowledgedBy` | string \| null | no |  |
| `acknowledgedAt` | string \| null | no |  |
| `resolvedAt` | string \| null | no |  |
| `fields` | { label: string, value: string }[] | yes |  |
| `colour` | string \| null | no |  |
| `common` | [CommonFields](#schema-commonfields) | no |  |

<a id="schema-alertdetail"></a>

### AlertDetail

An Alert with its opening event (null when unavailable) and its suggestions.

Type: [Alert](#schema-alert) & { event: [Event](#schema-event) \| null, suggestions: [Suggestion](#schema-suggestion)[] }

<a id="schema-alertstate"></a>

### AlertState

Type: "open" \| "acknowledged" \| "resolved"

<a id="schema-alertsummary"></a>

### AlertSummary

| name | type | required | description |
| --- | --- | --- | --- |
| `open` | integer | yes | Number of open alerts |
| `bySeverity` | { critical: integer, error: integer, warning: integer, info: integer } | yes | Open alerts per severity |
| `byStatus` | { open: integer, acknowledged: integer, resolved: integer } | yes | All alerts per state |

<a id="schema-alerttransitionrequest"></a>

### AlertTransitionRequest

| name | type | required | description |
| --- | --- | --- | --- |
| `actor` | string | no | Defaults to the x-actor header, else anonymous |

<a id="schema-approvesteprequest"></a>

### ApproveStepRequest

| name | type | required | description |
| --- | --- | --- | --- |
| `actor` | string | no |  |
| `runbookId` | string | no | Needed when several runbooks await approval at that step |
| `decision` | "approve" \| "skip" | no |  |

<a id="schema-auditentry"></a>

### AuditEntry

| name | type | required | description |
| --- | --- | --- | --- |
| `id` | string | yes |  |
| `alertId` | string | yes |  |
| `at` | string | yes |  |
| `actor` | string | yes | Person id or system |
| `action` | "created" \| "acknowledged" \| "resolved" \| "step_executed" \| "step_approved" \| "step_skipped" \| "escalated" \| "suggestion" | yes |  |
| `runbookId` | string \| null | no |  |
| `stepIndex` | integer \| null | no |  |
| `result` | string \| null | no |  |
| `detail` | string \| null | no |  |

<a id="schema-channelstatus"></a>

### ChannelStatus

| name | type | required | description |
| --- | --- | --- | --- |
| `id` | string | yes |  |
| `healthy` | boolean | yes |  |
| `pending` | integer | yes |  |
| `deadLetters` | integer | yes |  |
| `lastError` | string | no |  |

<a id="schema-commonfields"></a>

### CommonFields

| name | type | required | description |
| --- | --- | --- | --- |
| `severity` | [Severity](#schema-severity) | no |  |
| `title` | string | no |  |
| `source` | string | no |  |
| `environment` | string | no |  |
| `dedupKey` | string | no |  |
| `status` | "firing" \| "resolved" | no |  |
| `occurredAt` | string \| number \| null | no | ISO timestamp (or epoch value as mapped) |

<a id="schema-deadletter"></a>

### DeadLetter

| name | type | required | description |
| --- | --- | --- | --- |
| `id` | string | yes | Equals notification.id |
| `notification` | [Notification](#schema-notification) | yes |  |
| `error` | string | yes |  |
| `failedAt` | string | yes |  |

<a id="schema-error"></a>

### Error

| name | type | required | description |
| --- | --- | --- | --- |
| `error` | string | yes | Human-readable message |
| `position` | integer | no | 1-based column of a filter syntax error |

<a id="schema-event"></a>

### Event

| name | type | required | description |
| --- | --- | --- | --- |
| `id` | string | yes |  |
| `sourceId` | string | yes |  |
| `receivedAt` | string | yes |  |
| `raw` | string \| [JsonObject](#schema-jsonobject) | yes | Raw message as received (string for lines, object for JSON) |
| `parsed` | [JsonObject](#schema-jsonobject) | yes |  |
| `schemaId` | string \| null | no |  |
| `common` | [CommonFields](#schema-commonfields) | yes |  |

<a id="schema-fieldmapping"></a>

### FieldMapping

| name | type | required | description |
| --- | --- | --- | --- |
| `valueMap` | map<string, string> | no | e.g. { ERROR: error } |
| `default` | string | no | Used when the path/template yields nothing |

<a id="schema-filter"></a>

### Filter

A filter expression as text (e.g. `alert.severity = critical`) or as the parsed JSON tree.

Type: string \| [FilterNode](#schema-filternode)

<a id="schema-filterformatrequest"></a>

### FilterFormatRequest

| name | type | required | description |
| --- | --- | --- | --- |
| `tree` | [FilterNode](#schema-filternode) | yes |  |

<a id="schema-filterformatresponse"></a>

### FilterFormatResponse

| name | type | required | description |
| --- | --- | --- | --- |
| `text` | string | yes |  |

<a id="schema-filternode"></a>

### FilterNode

Type: { type: "and", children: [FilterNode](#schema-filternode)[] } \| { type: "or", children: [FilterNode](#schema-filternode)[] } \| { type: "not", child: [FilterNode](#schema-filternode) } \| { type: "cmp", field: string, op: "=" \| "!=" \| ">" \| ">=" \| "<" \| "<=" \| "contains" \| "matches", value: [FilterValue](#schema-filtervalue) } \| { type: "in", field: string, values: [FilterValue](#schema-filtervalue)[] }

<a id="schema-filterparseerror"></a>

### FilterParseError

| name | type | required | description |
| --- | --- | --- | --- |
| `message` | string | yes |  |
| `position` | integer | yes |  |

<a id="schema-filterparseresponse"></a>

### FilterParseResponse

| name | type | required | description |
| --- | --- | --- | --- |
| `tree` | [FilterNode](#schema-filternode) | yes |  |

<a id="schema-filtertextrequest"></a>

### FilterTextRequest

| name | type | required | description |
| --- | --- | --- | --- |
| `text` | string | yes |  |

<a id="schema-filtervalue"></a>

### FilterValue

Type: string \| number

<a id="schema-group"></a>

### Group

| name | type | required | description |
| --- | --- | --- | --- |
| `id` | string | yes |  |
| `name` | string | yes |  |
| `memberIds` | string[] | yes |  |

<a id="schema-health"></a>

### Health

| name | type | required | description |
| --- | --- | --- | --- |
| `ok` | boolean | yes |  |
| `checks` | { postgres: boolean, redis: boolean } | yes |  |

<a id="schema-ingestresult"></a>

### IngestResult

| name | type | required | description |
| --- | --- | --- | --- |
| `accepted` | integer | yes |  |

<a id="schema-jsonobject"></a>

### JsonObject

Type: object

<a id="schema-looks"></a>

### Looks

| name | type | required | description |
| --- | --- | --- | --- |
| `titleTemplate` | string | yes |  |
| `bodyTemplate` | string | no |  |
| `fields` | string[] | yes |  |
| `severityOverride` | [Severity](#schema-severity) | no |  |
| `colour` | string | no |  |

<a id="schema-notification"></a>

### Notification

| name | type | required | description |
| --- | --- | --- | --- |
| `id` | string | yes |  |
| `alertId` | string | yes |  |
| `recipientId` | string | yes |  |
| `channel` | string | yes |  |
| `severity` | [Severity](#schema-severity) | yes |  |
| `title` | string | yes |  |
| `body` | string | no |  |
| `clickUrl` | string | yes |  |
| `runbookUrl` | string | no |  |
| `digestAlertIds` | string[] | no |  |
| `attempt` | integer | yes |  |
| `createdAt` | string | yes |  |
| `nextAttemptAt` | number | no | Epoch ms of the next retry |

<a id="schema-parserconfig"></a>

### ParserConfig

| name | type | required | description |
| --- | --- | --- | --- |
| `type` | "json" \| "logfmt" \| "regex" \| "raw" | yes |  |
| `pattern` | string | no | For regex: pattern with named groups |

<a id="schema-pendingapproval"></a>

### PendingApproval

| name | type | required | description |
| --- | --- | --- | --- |
| `alertId` | string | yes |  |
| `runbookId` | string | yes |  |
| `stepIndex` | integer | yes |  |
| `stepName` | string | no |  |
| `requestedAt` | string | yes |  |

<a id="schema-person"></a>

### Person

| name | type | required | description |
| --- | --- | --- | --- |
| `id` | string | yes |  |
| `name` | string | yes |  |
| `role` | string | yes |  |
| `canCreateRules` | boolean | yes |  |
| `ntfyTopic` | string \| null | no |  |
| `starredFilters` | [StarredFilter](#schema-starredfilter)[] | no |  |

<a id="schema-preference"></a>

### Preference

| name | type | required | description |
| --- | --- | --- | --- |
| `ownerType` | "person" \| "group" | yes |  |
| `ownerId` | string | yes |  |
| `rules` | [PreferenceRule](#schema-preferencerule)[] | yes |  |
| `quietHours` | [QuietHours](#schema-quiethours) | no |  |

<a id="schema-preferencerule"></a>

### PreferenceRule

| name | type | required | description |
| --- | --- | --- | --- |
| `when` | [FilterNode](#schema-filternode) | yes |  |
| `channels` | string[] | yes |  |

<a id="schema-quiethours"></a>

### QuietHours

| name | type | required | description |
| --- | --- | --- | --- |
| `from` | string | yes | HH:MM |
| `to` | string | yes | HH:MM |
| `timezone` | string | yes |  |
| `allowChannels` | string[] | no |  |

<a id="schema-recipientref"></a>

### RecipientRef

| name | type | required | description |
| --- | --- | --- | --- |
| `type` | "person" \| "group" | yes |  |
| `id` | string | yes |  |

<a id="schema-rule"></a>

### Rule

| name | type | required | description |
| --- | --- | --- | --- |
| `id` | string | yes |  |
| `name` | string | yes |  |
| `enabled` | boolean | yes |  |
| `when` | [Filter](#schema-filter) | yes |  |
| `who` | [WhoRow](#schema-whorow)[] | yes |  |
| `looks` | [Looks](#schema-looks) | yes |  |
| `dedupFields` | "severity" \| "title" \| "source" \| "environment" \| "dedupKey" \| "status" \| "occurredAt"[] | no |  |
| `createdAt` | string | no |  |
| `updatedAt` | string | no |  |

<a id="schema-runbook"></a>

### Runbook

Type: { id: string, name: string, type: "text", matches: [Filter](#schema-filter), content: string } \| { id: string, name: string, type: "automation", matches: [Filter](#schema-filter), steps: [RunbookStep](#schema-runbookstep)[] }

<a id="schema-runbookrun"></a>

### RunbookRun

| name | type | required | description |
| --- | --- | --- | --- |
| `alertId` | string | yes |  |
| `runbookId` | string | yes |  |
| `runbookName` | string | no |  |
| `status` | "running" \| "awaiting_approval" \| "done" \| "failed" | no |  |
| `steps` | { index: integer, state: [StepRunState](#schema-steprunstate), result?: string, at?: string, name?: string }[] | yes |  |

<a id="schema-runbookstep"></a>

### RunbookStep

Type: { action: "http", name?: string, method: string, url: string, headers?: map<string, string>, body?: string, approval: "none" \| "required" } \| { action: "escalate", name?: string, group: string, approval: "none" \| "required" } \| { action: "wait", name?: string, duration: string, approval: "none" \| "required" }

<a id="schema-schema"></a>

### Schema

| name | type | required | description |
| --- | --- | --- | --- |
| `id` | string | yes |  |
| `name` | string | yes |  |
| `match` | [Filter](#schema-filter) | yes |  |
| `mapping` | map<string, [FieldMapping](#schema-fieldmapping)> | yes | Keys are common field names (severity, title, source, environment, dedupKey, status, occurredAt) and further names such as sourceStatus, type, message, entity, runbookUrl. |

<a id="schema-schematestrequest"></a>

### SchemaTestRequest

| name | type | required | description |
| --- | --- | --- | --- |
| `schema` | [Schema](#schema-schema) | yes |  |
| `sample` | [JsonObject](#schema-jsonobject) | yes |  |

<a id="schema-schematestresponse"></a>

### SchemaTestResponse

| name | type | required | description |
| --- | --- | --- | --- |
| `matched` | boolean | yes |  |
| `common` | [CommonFields](#schema-commonfields) | yes |  |

<a id="schema-sessioncreate"></a>

### SessionCreate

| name | type | required | description |
| --- | --- | --- | --- |
| `personId` | string | yes |  |

<a id="schema-severity"></a>

### Severity

Type: "info" \| "warning" \| "error" \| "critical"

<a id="schema-source"></a>

### Source

Type: [SourceBase](#schema-sourcebase) & { type: "http", config: object } \| [SourceBase](#schema-sourcebase) & { type: "file_tail", config: { path: string } } \| [SourceBase](#schema-sourcebase) & { type: "redis_stream", config: { stream: string, consumerGroup: string } }

<a id="schema-sourcebase"></a>

### SourceBase

| name | type | required | description |
| --- | --- | --- | --- |
| `id` | string | yes |  |
| `name` | string | yes |  |
| `enabled` | boolean | yes |  |
| `parser` | [ParserConfig](#schema-parserconfig) | yes |  |

<a id="schema-sourcetestrequest"></a>

### SourceTestRequest

| name | type | required | description |
| --- | --- | --- | --- |
| `parser` | [ParserConfig](#schema-parserconfig) | yes |  |
| `sample` | string | yes |  |

<a id="schema-sourcetestresponse"></a>

### SourceTestResponse

| name | type | required | description |
| --- | --- | --- | --- |
| `parsed` | [JsonObject](#schema-jsonobject) | yes |  |

<a id="schema-sourcetype"></a>

### SourceType

Type: "http" \| "file_tail" \| "redis_stream"

<a id="schema-sourcetypeinfo"></a>

### SourceTypeInfo

| name | type | required | description |
| --- | --- | --- | --- |
| `type` | string | yes |  |
| `configSchema` | [JsonObject](#schema-jsonobject) | yes |  |

<a id="schema-sourcetypesresponse"></a>

### SourceTypesResponse

| name | type | required | description |
| --- | --- | --- | --- |
| `sourceTypes` | [SourceTypeInfo](#schema-sourcetypeinfo)[] | yes |  |
| `parserConfigSchema` | [JsonObject](#schema-jsonobject) | yes |  |

<a id="schema-starredfilter"></a>

### StarredFilter

| name | type | required | description |
| --- | --- | --- | --- |
| `id` | string | yes |  |
| `personId` | string | no | Set by the server from the path |
| `name` | string | yes |  |
| `filter` | [FilterNode](#schema-filternode) | yes |  |

<a id="schema-steprunstate"></a>

### StepRunState

Type: "pending" \| "awaiting_approval" \| "running" \| "done" \| "failed" \| "skipped"

<a id="schema-suggestion"></a>

### Suggestion

| name | type | required | description |
| --- | --- | --- | --- |
| `id` | string | yes |  |
| `ruleId` | string | yes |  |
| `alertId` | string \| null | no |  |
| `author` | string | yes |  |
| `text` | string | yes |  |
| `status` | "open" \| "accepted" \| "dismissed" | yes |  |
| `createdAt` | string | yes |  |

<a id="schema-suggestionrequest"></a>

### SuggestionRequest

| name | type | required | description |
| --- | --- | --- | --- |
| `text` | string | yes |  |
| `author` | string | no | Defaults to the x-actor header, else anonymous |
| `alertId` | string | no | Only for /api/rules/{id}/suggestions; must belong to the rule |

<a id="schema-testfilterrequest"></a>

### TestFilterRequest

| name | type | required | description |
| --- | --- | --- | --- |
| `filter` | string \| [FilterNode](#schema-filternode) \| null | no | Filter text or tree; empty or absent matches everything |
| `limit` | integer | no | How many recent events to test (default 1000) |

<a id="schema-testfilterresponse"></a>

### TestFilterResponse

| name | type | required | description |
| --- | --- | --- | --- |
| `matched` | integer | yes |  |
| `total` | integer | yes |  |
| `warning` | string | no |  |

<a id="schema-uipush"></a>

### UiPush

JSON payload of one SSE `data:` line on /api/stream.

Type: { type: "alert", alertId: string, kind: string } \| { type: "event", event: [Event](#schema-event) } \| { type: "dead_letter", count: integer }

<a id="schema-whorow"></a>

### WhoRow

| name | type | required | description |
| --- | --- | --- | --- |
| `condition` | [Filter](#schema-filter) | no |  |
| `recipients` | [RecipientRef](#schema-recipientref)[] | yes |  |
| `force` | string[] | no | Overrides recipients' preferences |
