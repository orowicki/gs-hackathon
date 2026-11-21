// Live reload of config/ YAML files in the running API process.
// watchConfigDir's initial scan upserts every existing file, which would overwrite edits made
// through the API on each start. So during that initial phase upserts are "insert if missing";
// once `ready` resolves, changes pass through unchanged (upserts overwrite, file deletes delete).
import { existsSync } from "node:fs";
import { watchConfigDir, type ConfigStore, type ConfigWatcher, type WatchOptions } from "@alerting/config";

export function startConfigWatch(store: ConfigStore, dir: string, opts: WatchOptions = {}): ConfigWatcher {
  const report = opts.onError ?? ((err, file) => console.error(`config watcher: ${file}: ${err.message}`));
  if (!existsSync(dir)) {
    report(new Error("config directory not found, live reload disabled"), dir);
    return { ready: Promise.resolve(), close: async () => {} };
  }
  let initial = true;
  const loadIfMissing: ConfigStore = {
    list: (kind) => store.list(kind),
    get: (kind, id) => store.get(kind, id),
    delete: (kind, id) => store.delete(kind, id),
    onChange: (kind, handler) => store.onChange(kind, handler),
    close: () => store.close(),
    async upsert(kind, entity) {
      if (initial) {
        const id = (entity as { id?: string }).id;
        if (id !== undefined && (await store.get(kind, id)) !== undefined) return;
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
