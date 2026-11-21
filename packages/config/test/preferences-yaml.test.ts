import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { entityId, watchConfigDir } from "../src/index.js";
import type { ConfigStore, Kind } from "../src/index.js";

function fakeStore(): ConfigStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    async upsert(kind: Kind, entity: unknown) {
      data.set(`${kind}/${entityId(kind, entity)}`, entity);
    },
    async delete(kind: Kind, id: string) {
      return data.delete(`${kind}/${id}`);
    },
  } as never;
}

async function until(cond: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const body = (extra = "") =>
  `ownerType: person\nownerId: anna\nrules:\n  - when: { type: cmp, field: alert.severity, op: "=", value: critical }\n    channels: [ui, ntfy]\n${extra}`;

describe("config/preferences/*.yaml", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("loads at start, updates on change, deletes on removal; id comes from the owner", async () => {
    dir = await mkdtemp(join(tmpdir(), "cfg-"));
    await mkdir(join(dir, "preferences"));
    const file = join(dir, "preferences", "whatever-name.yaml");
    await writeFile(file, body());
    const store = fakeStore();
    const w = watchConfigDir(store, dir, { onError: () => {}, debounceMs: 20 });
    await w.ready;
    const pref = store.data.get("preference/person:anna") as Record<string, unknown>;
    expect(pref).toMatchObject({ ownerType: "person", ownerId: "anna" });
    expect(pref).not.toHaveProperty("id");

    await writeFile(file, body("quietHours: { from: \"20:00\", to: \"08:00\", timezone: UTC }\n"));
    await until(() => "quietHours" in (store.data.get("preference/person:anna") as object));

    await unlink(file);
    await until(() => !store.data.has("preference/person:anna"));
    await w.close();
  });

  it("reports invalid owner and duplicates via onError without stopping", async () => {
    dir = await mkdtemp(join(tmpdir(), "cfg-"));
    await mkdir(join(dir, "preferences"));
    await writeFile(join(dir, "preferences", "bad.yaml"), "ownerType: team\nownerId: x\nrules: []\n");
    await writeFile(join(dir, "preferences", "noowner.yaml"), "ownerType: group\nrules: []\n");
    await writeFile(join(dir, "preferences", "a.yaml"), body());
    const store = fakeStore();
    const errors: string[] = [];
    const w = watchConfigDir(store, dir, { onError: (e) => errors.push(e.message), debounceMs: 20 });
    await w.ready;
    expect(errors.filter((m) => /invalid preference/.test(m))).toHaveLength(2);
    expect([...store.data.keys()]).toEqual(["preference/person:anna"]);
    await writeFile(join(dir, "preferences", "b.yaml"), body());
    await until(() => errors.some((m) => /duplicate preference id 'person:anna'/.test(m)));
    await w.close();
  });
});
