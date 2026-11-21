import { watch, type FSWatcher } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { entityId } from "./store.js";
import type { ConfigStore, Kind, KindMap } from "./store.js";
import { fromYaml } from "./yaml.js";

/** Directory name under the config dir -> entity kind. */
export const KIND_DIRS: Record<string, Exclude<Kind, "preference">> = {
  sources: "source",
  schemas: "schema",
  rules: "rule",
  people: "person",
  groups: "group",
  runbooks: "runbook",
};

export interface WatchOptions {
  onError?: (err: Error, file: string) => void;
  /** Debounce for rapid writes and delay before deletes, default 100 ms. */
  debounceMs?: number;
}

export interface ConfigWatcher {
  close(): Promise<void>;
  /** Resolves after the initial load of existing files. */
  ready: Promise<void>;
}

const isYaml = (f: string) =>
  [".yaml", ".yml"].includes(extname(f).toLowerCase());

/**
 * Watch `dir/{sources,schemas,rules,people,groups,runbooks}/*.{yaml,yml}` and mirror files into the
 * store (DB only; never writes files). Entity id = `id` in the YAML, falling back to the file
 * basename without extension (not for preferences, which derive it from the owner).
 *
 * Kind directories may appear later (or be deleted and recreated); the root is watched too. Several
 * files may define the same id: the entity is deleted only when no file defines it any more, and
 * the duplicate is reported via onError. Deletes are delayed by the debounce window so a rename
 * (a.yaml -> b.yaml, same id) does not publish delete+upsert. Files removed while the watcher was
 * down are not reconciled: their rows stay in the DB.
 */
export function watchConfigDir(
  store: ConfigStore,
  dir: string,
  opts: WatchOptions = {},
): ConfigWatcher {
  const debounceMs = opts.debounceMs ?? 100;
  const report =
    opts.onError ??
    ((err, file) => console.error(`config watcher: ${file}: ${err.message}`));
  /** file path -> last seen content and the entity it produced */
  const known = new Map<string, { text: string; kind: Kind; id: string }>();
  /** "kind/id" -> files currently defining it */
  const owners = new Map<string, Set<string>>();
  const pendingDeletes = new Map<
    string,
    { kind: Kind; id: string; timer: NodeJS.Timeout }
  >();
  const kindWatchers = new Map<string, FSWatcher>();
  let rootWatcher: FSWatcher | undefined;
  const timers = new Map<string, NodeJS.Timeout>();
  let closed = false;
  let chain: Promise<void> = Promise.resolve();

  const fail = (err: unknown, file: string) => {
    try {
      report(err instanceof Error ? err : new Error(String(err)), file);
    } catch {
      /* reporter must not stop the watcher */
    }
  };

  const enqueue = (job: () => Promise<void>) => {
    chain = chain.then(job).catch((err) => fail(err, dir));
    return chain;
  };

  async function runDelete(kind: Kind, id: string): Promise<void> {
    pendingDeletes.delete(`${kind}/${id}`);
    if (owners.has(`${kind}/${id}`)) return;
    try {
      await store.delete(kind, id);
    } catch (err) {
      fail(err, `${kind}/${id}`);
    }
  }

  function release(file: string, kind: Kind, id: string) {
    const key = `${kind}/${id}`;
    const set = owners.get(key);
    set?.delete(file);
    if (set && set.size === 0) {
      owners.delete(key);
      clearTimeout(pendingDeletes.get(key)?.timer);
      const timer = setTimeout(
        () => void enqueue(() => runDelete(kind, id)),
        debounceMs,
      );
      pendingDeletes.set(key, { kind, id, timer });
    }
  }

  async function syncFile(kind: Kind, file: string): Promise<void> {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      const prev = known.get(file);
      if (prev) {
        known.delete(file);
        release(file, prev.kind, prev.id);
      }
      return;
    }
    if (known.get(file)?.text === text) return;
    try {
      let value = fromYaml(text);
      if (
        kind !== "preference" &&
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value)
      ) {
        const v = value as Record<string, unknown>;
        if (v.id === undefined)
          value = { ...v, id: basename(file, extname(file)) };
      }
      const id = entityId(kind, value);
      const key = `${kind}/${id}`;
      const other = [...(owners.get(key) ?? [])].find((f) => f !== file);
      if (other)
        fail(
          new Error(`duplicate ${kind} id '${id}' (also defined in ${other})`),
          file,
        );
      clearTimeout(pendingDeletes.get(key)?.timer);
      pendingDeletes.delete(key);
      await store.upsert(kind, value as KindMap[typeof kind]);
      const prev = known.get(file);
      known.set(file, { text, kind, id });
      let set = owners.get(key);
      if (!set) owners.set(key, (set = new Set()));
      set.add(file);
      if (prev && prev.id !== id) release(file, prev.kind, prev.id); // id renamed inside the file
    } catch (err) {
      fail(err, file);
    }
  }

  const schedule = (kind: Kind, file: string) => {
    clearTimeout(timers.get(file));
    timers.set(
      file,
      setTimeout(() => {
        timers.delete(file);
        if (!closed) void enqueue(() => syncFile(kind, file));
      }, debounceMs),
    );
  };

  async function scanDir(kind: Kind, sub: string): Promise<void> {
    let names: string[] = [];
    try {
      names = (await readdir(sub)).filter(isYaml);
    } catch {
      /* missing dir: nothing to load */
    }
    const present = new Set(names.map((n) => join(sub, n)));
    for (const file of present) await syncFile(kind, file);
    for (const file of [...known.keys()]) {
      if (file.startsWith(sub + "/") && !present.has(file))
        await syncFile(kind, file);
    }
  }

  /** (Re)arm the watcher of one kind directory, if it exists. */
  function arm(name: string, kind: Kind): void {
    const sub = join(dir, name);
    kindWatchers.get(name)?.close();
    kindWatchers.delete(name);
    try {
      const w = watch(sub, (_ev, filename) => {
        if (closed) return;
        if (filename && isYaml(String(filename)))
          schedule(kind, join(sub, String(filename)));
        else if (!filename) void enqueue(() => scanDir(kind, sub));
      });
      w.on("error", (err) => fail(err, sub));
      kindWatchers.set(name, w);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") fail(err, sub);
    }
  }

  const ready = (async () => {
    try {
      rootWatcher = watch(dir, (_ev, filename) => {
        if (closed || !filename) return;
        const name = String(filename);
        const kind = KIND_DIRS[name];
        if (!kind) return;
        arm(name, kind); // dir created, deleted or recreated
        void enqueue(() => scanDir(kind, join(dir, name)));
      });
      rootWatcher.on("error", (err) => fail(err, dir));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") fail(err, dir);
    }
    for (const [name, kind] of Object.entries(KIND_DIRS)) {
      arm(name, kind);
      await enqueue(() => scanDir(kind, join(dir, name)));
    }
  })();

  return {
    ready,
    async close() {
      if (closed) return;
      closed = true;
      rootWatcher?.close();
      for (const w of kindWatchers.values()) w.close();
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      await ready.catch(() => {});
      await chain;
      // flush deletes that were waiting out the debounce window
      for (const p of [...pendingDeletes.values()]) {
        clearTimeout(p.timer);
        await runDelete(p.kind, p.id);
      }
    },
  };
}
