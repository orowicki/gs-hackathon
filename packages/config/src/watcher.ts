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
  /** Debounce for rapid writes, default 100 ms. */
  debounceMs?: number;
}

export interface ConfigWatcher {
  close(): Promise<void>;
  /** Resolves after the initial load of existing files. */
  ready: Promise<void>;
}

const isYaml = (f: string) => [".yaml", ".yml"].includes(extname(f).toLowerCase());

/**
 * Watch `dir/{sources,schemas,rules,people,groups,runbooks}/*.{yaml,yml}` and mirror files into the
 * store (DB only; never writes files). Entity id = `id` in the YAML, falling back to the file
 * basename without extension (not for preferences, which derive it from the owner).
 */
export function watchConfigDir(store: ConfigStore, dir: string, opts: WatchOptions = {}): ConfigWatcher {
  const debounceMs = opts.debounceMs ?? 100;
  const report = opts.onError ?? ((err, file) => console.error(`config watcher: ${file}: ${err.message}`));
  /** file path -> last seen content and the entity it produced */
  const known = new Map<string, { text: string; kind: Kind; id: string }>();
  const watchers: FSWatcher[] = [];
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

  async function syncFile(kind: Kind, file: string): Promise<void> {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      const prev = known.get(file);
      if (prev) {
        known.delete(file);
        try {
          await store.delete(prev.kind, prev.id);
        } catch (err) {
          fail(err, file);
        }
      }
      return;
    }
    if (known.get(file)?.text === text) return;
    try {
      let value = fromYaml(text);
      if (kind !== "preference" && typeof value === "object" && value !== null && !Array.isArray(value)) {
        const v = value as Record<string, unknown>;
        if (v.id === undefined) value = { ...v, id: basename(file, extname(file)) };
      }
      const id = entityId(kind, value);
      await store.upsert(kind, value as KindMap[typeof kind]);
      const prev = known.get(file);
      known.set(file, { text, kind, id });
      if (prev && prev.id !== id) await store.delete(prev.kind, prev.id); // id renamed inside the file
    } catch (err) {
      fail(err, file);
    }
  }

  const enqueue = (job: () => Promise<void>) => {
    chain = chain.then(job).catch((err) => fail(err, dir));
    return chain;
  };

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
      if (file.startsWith(sub + "/") && !present.has(file)) await syncFile(kind, file);
    }
  }

  const ready = (async () => {
    for (const [name, kind] of Object.entries(KIND_DIRS)) {
      const sub = join(dir, name);
      try {
        const w = watch(sub, (_ev, filename) => {
          if (closed) return;
          if (filename && isYaml(String(filename))) schedule(kind, join(sub, String(filename)));
          else if (!filename) void enqueue(() => scanDir(kind, sub));
        });
        w.on("error", (err) => fail(err, sub));
        watchers.push(w);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") fail(err, sub);
      }
      await enqueue(() => scanDir(kind, sub));
    }
  })();

  return {
    ready,
    async close() {
      closed = true;
      for (const w of watchers) w.close();
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      await ready.catch(() => {});
      await chain;
    },
  };
}
