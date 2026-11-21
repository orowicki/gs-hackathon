# Notes from the human

> Only the human writes here (the guard hook blocks the agent). The coordinator reads
> it at every resume. Use it for hints, corrections or "stop doing X".

## 2026-11-21 · Alert `status` vs `state` (decided by @igorstec)

These are two different fields and both stay. Do not rename either.

- `status` is a **common field taken from the source event**: `firing | resolved`
  (e.g. Alertmanager's `status`). Filter field: `alert.status`.
- `state` is **our alert lifecycle**: `open | acknowledged | resolved` (`Alert.state` in
  `@alerting/shared`). Filter field: **`alert.state`**. The filter language does not have
  it yet: add it to the field list, autocomplete values and evaluator context, so that
  `alert.state = open` shows only unacknowledged alerts.
- When building the filter context for an alert, expose both: `alert.status` from
  `common.status` and `alert.state` from `Alert.state`.

## 2026-11-21 · Common fields: add four optional fields (decided by @igorstec)

The seven common fields are not enough for the task's own examples (Appendix A rules and
Appendix B runbooks) and miss concepts every alerting product has (PagerDuty, Alertmanager,
Opsgenie). Add these four **optional** common fields. Mapping works exactly like the
existing
ones (path, constant or template, optional value map and default).

| Field | Meaning | Why we need it | Mapping in the Appendix A schemas |
|---|---|---|---|
| `type` | kind of event, finer than the schema | "any `WORKFLOW_FAILED`"; one Alertmanager
schema covers many alert names; runbook matching | workflow: `type` · alertmanager:
`alertname` · trade: `meta.schema` |
| `message` | longer human-readable description | expanded alert row, default email/SMS
body, "show the error message" | workflow: `error.message` · alertmanager:
`annotations.summary` · trade: template `"{{payload.reason}} on {{payload.desk}} desk"` |
| `entity` | the main object the alert is about | group "one alert per instrument", "restart
the instance named in the alert", IDs shown in the UI | workflow: `workflowId` ·
alertmanager: `labels.service` · trade: `payload.tradeId` · pricing logs: `instrument` |
| `runbookUrl` | link to a runbook sent by the source | industry convention
(`annotations.runbook_url`); feeds the "link" runbook format | alertmanager:
`annotations.runbook_url` |

Rules for this change:
- All four are optional (`CommonFields` stays `Partial` on events and alerts); nothing that
  exists today may break.
- Update `CommonFields` and `COMMON_FIELD_NAMES` in `packages/shared/src/types/common.ts`
  (shared contracts, owned by @orowicki's track; coordinate in a team note), the filter
  field list and autocomplete, the seeded schema YAML in `config/schemas/`, and the
  Schemas page click-to-map form (M4).
- `alert.type`, `alert.message`, `alert.entity` and `alert.runbookUrl` work in filters like
  the other common fields.
- No user-defined custom common fields beyond these eleven. Everything else (e.g. `desk`,
  `notional`, `region`) stays reachable in filters through raw event paths
  (`payload.notional`, `error.code`).
- `source` keeps its meaning: the system that emitted the event (e.g. `payments-api`), not
  the ingest connector (`sourceId`). Make this clear in UI labels and help text.
