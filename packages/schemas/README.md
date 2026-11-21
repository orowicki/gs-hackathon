# @alerting/schemas

Recognise an event's schema and map it onto the common fields.

- `matchSchema(parsed, schemas, onError?)`: first match wins. Schemas are sorted by `id` ascending
  (plain string compare), so control order with id prefixes (`10-foo` before `20-bar`). A schema
  whose `match` filter fails to parse is skipped and reported via `onError`. Empty filter matches all.
- `mapCommonFields(parsed, schema)`: per field `path` (dot path, array index `a.0.b`), `constant` or
  `template` (`{{a.b}}`). A template with any missing/empty placeholder counts as missing. Then
  `valueMap` (exact, then case-insensitive), then `default`. `severity`: case/alias normalised
  (`warn`, `crit`), unknown -> `info`. `status`: `firing|resolved` (case-insensitive), unknown ->
  omitted. `occurredAt` (value -> valueMap -> default, like the others): ISO, epoch seconds (< 1e11)
  or epoch ms -> ISO `toISOString()`. Numeric *strings* count as epoch only with >= 9 digits, so
  `"2026"` / `"20261023"` are omitted (not 1970); unparseable -> omitted. Fields without a value are omitted.
- `classifyEvent(parsed, schemas)` -> `{ schemaId, common, parsed }`. The event is normalised
  automatically first (`normaliseDeep`): `match` filters and mappings run on the normalised event, and
  `parsed` is that normalised object (ingest stores it). Unmatched is `{ schemaId: null, common: {}, parsed }`
  and fields stay available to filters (`event.<path>`). Common string fields (title, dedupKey, ...)
  stay strings (template/path output is stringified).
- `normaliseValue(v)`: only canonical decimal strings become numbers (optional `-`, no leading zeros
  except `0`/`0.x`, no `+`, no exponent, no whitespace, finite, integers in safe range). `"007"` and long
  digit ids stay strings. `normaliseDeep` applies it to every string leaf.
  Filter note: after normalisation `code = "42"` and `code = 42` both match `{code:"42"}` (the filter
  compares a string literal via `String(actual)`), but `code = "042"` does not. Use numeric literals
  for numeric comparison (`n > 40`).
- `createSchemaRegistry(store)` -> `{ ready, classify, schemas, close }`; re-lists on every `schema`
  change from the config store, so changes apply to the next event without restart. Invalid entries
  are skipped and reported via `onError`. If the initial load fails, `ready` rejects (and `onError`
  is called) while the subscription stays: the next `schema` change event retries the load. `classify`
  does not retry on its own; until then it uses the schemas loaded so far (none). Later failed reloads
  keep the previous schemas.

Seed schemas for the Appendix A events live in `config/schemas/`.
