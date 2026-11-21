# Data model

Source of truth: `packages/shared/src/types/*.ts` (import from `@alerting/shared`). Plain types, no runtime validation. Ids are strings, timestamps ISO strings, channels are strings (`ui`, `ntfy`, extensible).

| Type | File | Notes |
|---|---|---|
| Event | `event.ts` | id, sourceId, receivedAt, raw, parsed, schemaId or null, `common` (Partial when no schema matched) |
| Source | `source.ts` | `http`, `file_tail`, `redis_stream` with per-type config; parser `json`, `logfmt`, `regex`, `raw` |
| Schema, FieldMapping | `schema.ts` | `match` filter + mapping per common field: path, constant or template, optional valueMap and default |
| Filter, FilterNode | `filter.ts` | text, or JSON tree with node types `cmp` (`field`, `op` in `= != > >= < <= contains matches`, `value`), `in` (`field`, `values`), `and`, `or`, `not`; source of truth is `filter.md` |
| Rule | `rule.ts` | `when` filter, `who` rows (condition, recipients, optional `force`), `looks` |
| Person, Group, Preference | `people.ts` | preferences are filter to channels rules plus quiet hours |
| Alert, AuditEntry, Suggestion | `alert.ts` | states open, acknowledged, resolved |
| Notification, DeadLetter, ChannelStatus | `notification.ts` | one notification = one recipient on one channel |
| Runbook | `runbook.ts` | `text` or `automation` (steps http, escalate, wait; `approval: none or required`; optional `approvers` = group id notified with an ntfy Approve button when a step awaits approval, default the alert's own recipients) |
| Severity, CommonFields | `common.ts` | `SEVERITY_ORDER`, `compareSeverity()` (critical > error > warning > info) |

Conventions: common fields live under `common` on both Event and Alert (`Partial` when no schema matched). Alert uses `state` (open, acknowledged, resolved); `status` (firing, resolved) exists only on events/common fields. `StarredFilter` (`people.ts`) is per profile; `RunbookRun` and `PendingApproval` (`runbook.ts`) back the runbook-run and approval routes; `DeadLetter.id` equals its notification id.

Example: `fixtures/alerts/workflow-failed.json` (an `Alert`); sample events in `fixtures/events/`.

Who uses it: A (ingest, schemas) writes Event, Source, Schema; B (engine, delivery) reads Event and writes Alert, Notification; C (web, runbooks) reads Alert and owns Runbook and AuditEntry. Changing a type needs a DECISIONS.md entry.
