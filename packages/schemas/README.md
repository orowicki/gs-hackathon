# @alerting/schemas

Recognise an event's schema and map it onto the common fields.

- `matchSchema(parsed, schemas, onError?)`: first match wins. Schemas are sorted by `id` ascending
  (plain string compare), so control order with id prefixes (`10-foo` before `20-bar`). A schema
  whose `match` filter fails to parse is skipped and reported via `onError`. Empty filter matches all.
- `mapCommonFields(parsed, schema)`: per field `path` (dot path, array index `a.0.b`), `constant` or
  `template` (`{{a.b}}`). A template with any missing/empty placeholder counts as missing. Then
  `valueMap` (exact, then case-insensitive), then `default`. `severity`: case/alias normalised
  (`warn`, `crit`), unknown -> `info`. `status`: `firing|resolved` (case-insensitive), unknown ->
  omitted. `occurredAt`: ISO, epoch seconds (< 1e11) or epoch ms, number or numeric string ->
  ISO `toISOString()`; unparseable -> omitted. Fields without a value are omitted.
- `classifyEvent(parsed, schemas)` -> `{ schemaId, common }`; unmatched is `{ schemaId: null, common: {} }`
  and the raw event stays available to filters (`event.<path>`).
- `normaliseValue(v)`: numeric strings -> numbers (helper for filter contexts); `normaliseDeep`.
- `createSchemaRegistry(store)` -> `{ ready, classify, schemas, close }`; re-lists on every `schema`
  change from the config store, so changes apply to the next event without restart. Invalid entries
  are skipped and reported via `onError`.

Seed schemas for the Appendix A events live in `config/schemas/`.
