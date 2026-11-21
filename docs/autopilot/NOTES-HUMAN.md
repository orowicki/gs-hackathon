# Notes from the human

> Only the human writes here (the guard hook blocks the agent). The coordinator reads
> it at every resume. Use it for hints, corrections or "stop doing X".
- Root package.json must never list packages by name. Each package defines its own
  "build" and "typecheck" scripts; the root runs them with --workspaces --if-present.
- On rebase conflicts in package-lock.json: take main's version, then run `npm install`.
  Never hand-edit the lockfile.

## 2026-11-21 · Alert `status` vs `state` (decided by @igorstec)

These are two different fields and both stay. Do not rename either.

- `status` is a **common field taken from the source event**: `firing | resolved`
  (e.g. Alertmanager's `status`). Filter field: `alert.status`.
- `state` is **our alert lifecycle**: `open | acknowledged | resolved` (`Alert.state` in
  `@alerting/shared`). Filter field: **`alert.state`**, which the filter language does not
  have yet and must be added (field list, autocomplete values, evaluator context), e.g.
  `alert.state = open` shows only unacknowledged alerts.
- When building the filter context for an alert, expose both: `alert.status` from
  `common.status` and `alert.state` from `Alert.state`.

## 2026-11-21 · Schema mapping scope (decided by @igorstec)

The fixed set of seven common fields in the SPEC (`severity`, `title`, `source`,
`environment`, `dedupKey`, `status`, `occurredAt`) is enough. Do not add user-defined
mapped fields. Everything else stays reachable in filters through raw event paths
(`payload.notional`, `error.code`).
EOF
git add docs/autopilot/NOTES-HUMAN.md
git commit -m "docs: human notes on alert status vs state and schema mapping scope"
git push origin main
