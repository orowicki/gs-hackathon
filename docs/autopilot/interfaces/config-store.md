# Config store

Source: `packages/config` (`@alerting/config`). Postgres is the source of truth; changes are broadcast over Redis.

## API
`createConfigStore({ pool | databaseUrl, redis | redisUrl })` returns `ConfigStore`:
- `list(kind)`, `get(kind, id)` (undefined if missing), `upsert(kind, entity)` (validates id), `delete(kind, id)` (true if it existed)
- `onChange(kind | "*", handler)` returns `Promise<() => void>` (resolves once subscribed; call result to unsubscribe)
- `close()`. `migrate(pool)` creates tables.

## Kinds and tables
source `sources`, schema `schemas`, rule `rules`, person `people`, group `groups`, preference `preferences`, runbook `runbooks`. Each table: `id text pk, data jsonb, updated_at`.

Preference id rule: `${ownerType}:${ownerId}` (e.g. `person:p1`), since the type has no `id`.

## Change event
Channel `CHANNEL_CONFIG_CHANGE` (`@alerting/shared` streams), JSON `ConfigChange` = `{ kind, id, op: "upsert" | "delete" }`. Published after every upsert and effective delete. Publish failures are logged and do not fail the write (DB is the truth). Handler errors (sync or async) are logged and do not affect other handlers. `close()` is idempotent. Consumers re-read the entity with `get`.

## YAML
One entity per file in `config/{sources,schemas,rules,people,groups,runbooks,preferences}/*.yaml|yml`; see `config/README.md`. `watchConfigDir(store, dir, { onError?, debounceMs? })` returns `{ ready, close() }`: loads existing files, then upserts on add/change and deletes on removal. Id = YAML `id`, else file basename; for `preferences/` files the id is `${ownerType}:${ownerId}` from the content (e.g. `person:anna`), never the file name. Kind dirs may appear later. Duplicate ids across files are reported; the entity is deleted only when no file defines it. Deletes are delayed ~100 ms so a rename is not delete+upsert. Files deleted while the watcher was down stay in the DB. Invalid files go to `onError(err, file)`, never fatal.

Export/import: `exportYaml(store, kind, id)` (throws if missing), `importYaml(store, kind, text)` (validates like upsert, returns the entity), pure `toYaml` / `fromYaml`.

## Who uses it
A: ingest/parse read sources and schemas. B: rule engine and delivery read rules, people, groups, preferences, runbooks and react to change events. C: API CRUD routes write via the store and use export/import; app startup runs `migrate` and the watcher.
