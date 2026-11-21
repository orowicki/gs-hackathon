import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { entityId, exportYaml, fromYaml, importYaml, toYaml, watchConfigDir } from "../src/index.js";
import type { ConfigStore, Kind } from "../src/index.js";

function fakeStore(): ConfigStore & { data: Map<string, unknown>; ops: string[] } {
  const data = new Map<string, unknown>();
  const ops: string[] = [];
  return {
    data,
    ops,
    async list() {
      return [] as never;
    },
    async get(kind: Kind, id: string) {
      return data.get(`${kind}/${id}`) as never;
    },
    async upsert(kind: Kind, entity: unknown) {
      const id = entityId(kind, entity);
      data.set(`${kind}/${id}`, entity);
      ops.push(`upsert ${kind}/${id}`);
    },
    async delete(kind: Kind, id: string) {
      ops.push(`delete ${kind}/${id}`);
      return data.delete(`${kind}/${id}`);
    },
    async onChange() {
      return () => {};
    },
    async close() {},
  } as never;
}

async function until(cond: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("yaml helpers", () => {
  it("round-trips export/import", async () => {
    const store = fakeStore();
    const rule = { id: "r1", name: "Rule", enabled: true, tags: ["a", "b"] };
    await store.upsert("rule", rule as never);
    const text = await exportYaml(store, "rule", "r1");
    expect(fromYaml(text)).toEqual(rule);
    const store2 = fakeStore();
    expect(await importYaml(store2, "rule", text)).toEqual(rule);
    expect(store2.data.get("rule/r1")).toEqual(rule);
    expect(toYaml(rule)).toBe(text);
  });
  it("errors clearly", async () => {
    const store = fakeStore();
    await expect(exportYaml(store, "rule", "nope")).rejects.toThrow(/not found/);
    await expect(importYaml(store, "rule", "a: [unclosed")).rejects.toThrow(/invalid YAML/);
    await expect(importYaml(store, "rule", "name: x")).rejects.toThrow(/non-empty string id/);
    expect(store.ops).toEqual([]);
  });
});

describe("watchConfigDir", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("loads, upserts on add/change, deletes on removal, survives invalid files", async () => {
    dir = await mkdtemp(join(tmpdir(), "cfg-"));
    await mkdir(join(dir, "rules"));
    await mkdir(join(dir, "people"));
    await writeFile(join(dir, "rules", "existing.yaml"), "id: r0\nname: old\n");
    const store = fakeStore();
    const errors: Array<[string, string]> = [];
    const w = watchConfigDir(store, dir, { onError: (e, f) => errors.push([f, e.message]), debounceMs: 20 });
    await w.ready;
    expect(store.data.has("rule/r0")).toBe(true);

    await writeFile(join(dir, "people", "alice.yml"), "name: Alice\n"); // id from basename
    await until(() => store.data.has("person/alice"));

    await writeFile(join(dir, "rules", "existing.yaml"), "id: r0\nname: new\n");
    await until(() => (store.data.get("rule/r0") as { name: string }).name === "new");

    await writeFile(join(dir, "rules", "bad.yaml"), "a: [unclosed");
    await until(() => errors.length > 0);
    expect(errors[0]![0]).toBe(join(dir, "rules", "bad.yaml"));
    expect(errors[0]![1]).toMatch(/invalid YAML/);

    await writeFile(join(dir, "rules", "r2.yaml"), "name: two\n");
    await until(() => store.data.has("rule/r2"));

    await unlink(join(dir, "rules", "existing.yaml"));
    await until(() => !store.data.has("rule/r0"));
    await w.close();
  });
});
