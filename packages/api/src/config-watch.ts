// Live reload of config/ YAML files in the running API process.
// watchConfigDir's initial scan upserts every existing file, which would overwrite edits made
// through the API on each start. So during that initial phase upserts are "insert if missing";
// once `ready` resolves, changes pass through unchanged (upserts overwrite, file deletes delete).
import { existsSync } from "node:fs";
import { entityId, watchConfigDir, type ConfigStore, type ConfigWatcher, type WatchOptions } from "@alerting/config";

export function startConfigWatch(store: ConfigStore, dir: string, opts: WatchOptions = {}): ConfigWatcher {
  const report = opts.onError ?? ((err, file) => console.error(`config watcher: ${file}: ${err.message}`));
  if (!existsSync(dir)) {
    report(new Error("config directory not found, live reload disabled (restart the API after creating it)"), dir);
    return { ready: Promise.resolve(), close: async () => {} };
  }
  let initial = true;
  const seen = new Set<string>();
  const loadIfMissing: ConfigStore = {
    list: (kind) => store.list(kind),
    get: (kind, id) => store.get(kind, id),
    delete: (kind, id) => store.delete(kind, id),
    onChange: (kind, handler) => store.onChange(kind, handler),
    close: () => store.close(),
    async upsert(kind, entity) {
      if (initial) {
        // Only the first upsert per entity is the initial load; a later one is a real edit.
        const key = `${kind}/${entityId(kind, entity)}`;
        if (!seen.has(key)) {
          seen.add(key);
          if ((await store.get(kind, entityId(kind, entity))) !== undefined) return;
        }
      }
      await store.upsert(kind, entity);
    },
  };
  const watcher = watchConfigDir(loadIfMissing, dir, { ...opts, onError: report });
  void watcher.ready.then(
    () => {
      initial = false;
    },
    () => {
      initial = false;
    },
  );
  return watcher;
}
