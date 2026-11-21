import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, unlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { entityId, type ConfigStore, type ConfigWatcher, type Kind } from "@alerting/config";
import { startConfigWatch } from "../src/config-watch.js";

function fakeStore() {
  const data = new Map<string, unknown>();
  const store = {
    data,
    async list() {
      return [] as never;
    },
    async get(kind: Kind, id: string) {
      return data.get(`${kind}/${id}`) as never;
    },
    async upsert(kind: Kind, entity: unknown) {
      data.set(`${kind}/${entityId(kind, entity)}`, entity);
    },
    async delete(kind: Kind, id: string) {
      return data.delete(`${kind}/${id}`);
    },
    async onChange() {
      return () => {};
    },
    async close() {},
  };
  return store as unknown as ConfigStore & { data: Map<string, unknown> };
}

async function until(cond: () => boolean, ms = 1000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const name = (s: ConfigStore & { data: Map<string, unknown> }, key: string) =>
  (s.data.get(key) as { name?: string } | undefined)?.name;

describe("startConfigWatch", () => {
  let dir: string;
  let watcher: ConfigWatcher | undefined;
  afterEach(async () => {
    await watcher?.close();
    watcher = undefined;
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("does not overwrite an existing entity on start, inserts a missing one", async () => {
    dir = await mkdtemp(join(tmpdir(), "cfgw-"));
    await mkdir(join(dir, "rules"));
    await writeFile(join(dir, "rules", "a.yaml"), "id: a\nname: file\n");
    await writeFile(join(dir, "rules", "b.yaml"), "id: b\nname: file\n");
    const store = fakeStore();
    await store.upsert("rule", { id: "a", name: "api" } as never);
    watcher = startConfigWatch(store, dir, { debounceMs: 20 });
    await watcher.ready;
    expect(name(store, "rule/a")).toBe("api");
    expect(name(store, "rule/b")).toBe("file");
  });

  it("keeps an edit made before ready", async () => {
    dir = await mkdtemp(join(tmpdir(), "cfgw-"));
    await mkdir(join(dir, "rules"));
    await writeFile(join(dir, "rules", "a.yaml"), "id: a\nname: file\n");
    const store = fakeStore();
    await store.upsert("rule", { id: "a", name: "api" } as never);
    watcher = startConfigWatch(store, dir, { debounceMs: 5 });
    await writeFile(join(dir, "rules", "a.yaml"), "id: a\nname: edited\n");
    await watcher.ready;
    await until(() => name(store, "rule/a") === "edited");
  });

  it("applies new files, edits (overwrite) and deletes after ready", async () => {
    dir = await mkdtemp(join(tmpdir(), "cfgw-"));
    await mkdir(join(dir, "rules"));
    await writeFile(join(dir, "rules", "a.yaml"), "id: a\nname: file\n");
    const store = fakeStore();
    await store.upsert("rule", { id: "a", name: "api" } as never);
    watcher = startConfigWatch(store, dir, { debounceMs: 20 });
    await watcher.ready;

    await writeFile(join(dir, "rules", "n.yaml"), "name: new\n");
    await until(() => store.data.has("rule/n"));

    await writeFile(join(dir, "rules", "a.yaml"), "id: a\nname: edited\n");
    await until(() => name(store, "rule/a") === "edited");

    await unlink(join(dir, "rules", "n.yaml"));
    await until(() => !store.data.has("rule/n"));
  });

  it("does not throw when the directory is missing", async () => {
    dir = join(tmpdir(), "cfgw-missing-" + Date.now());
    const errors: string[] = [];
    watcher = startConfigWatch(fakeStore(), dir, { onError: (e) => errors.push(e.message) });
    await watcher.ready;
    expect(errors).toHaveLength(1);
  });
});
