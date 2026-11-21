# config/

YAML config, mirrored into Postgres by the watcher (`watchConfigDir` in `@alerting/config`).

Layout: one entity per file, the directory is the kind.

```
config/sources/*.yaml   config/schemas/*.yaml   config/rules/*.yaml
config/people/*.yaml    config/groups/*.yaml    config/runbooks/*.yaml
```

- `.yaml` and `.yml` are read. File content is the entity (same shape as the shared type).
- Id: the `id` field in the YAML; if missing, the file name without extension.
- Live reload: existing files load at start; adding or editing a file upserts it (changes are debounced ~100 ms); deleting a file deletes the entity it produced. Other processes are notified via the config change channel.
- Invalid YAML or an invalid entity is reported (logged with file path and reason) and skipped. It is never fatal and the watcher keeps running.
- The watcher only writes to the DB, never to these files.
- The app reads the directory from `CONFIG_DIR` (compose mounts `./config` at `/app/config`).
