import { describe, expect, it } from "vitest";
import { createRunbookRegistry } from "../src/index.js";
import { workflowAlert, workflowEvent } from "./helpers.js";

function fakeStore() {
  const data = new Map<string, unknown>();
  const handlers = new Set<(c: { kind: string; id: string; op: string }) => unknown>();
  return {
    list: async () => [...data.values()],
    onChange: async (_k: string, h: (c: { kind: string; id: string; op: string }) => unknown) => {
      handlers.add(h);
      return () => handlers.delete(h);
    },
    async emit(id: string, entity?: unknown) {
      if (entity) data.set(id, entity);
      else data.delete(id);
      await Promise.all([...handlers].map((h) => h({ kind: "runbook", id, op: entity ? "upsert" : "delete" })));
    },
    seed: (id: string, e: unknown) => data.set(id, e),
    handlers,
  };
}
const text = (id: string, matches: string) => ({ id, name: id, type: "text", matches, content: "c" });
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("runbook registry", () => {
  it("loads, skips invalid, reloads live, and closes", async () => {
    const store = fakeStore();
    store.seed("a", text("a", "type = WORKFLOW_FAILED"));
    store.seed("bad", { id: "bad", type: "text" });
    const errors: string[] = [];
    const reg = createRunbookRegistry(store as never, { onError: (e) => errors.push(e.message) });
    await reg.ready;
    expect(reg.all().map((r) => r.id)).toEqual(["a"]);
    expect(errors).toHaveLength(1);
    expect(reg.get("a")?.name).toBe("a");
    expect(reg.match({ alert: workflowAlert(), event: workflowEvent() })).toHaveLength(1);

    await store.emit("b", text("b", ""));
    await flush();
    expect(reg.all().map((r) => r.id).sort()).toEqual(["a", "b"]);
    await store.emit("a", { ...text("a", "type = NOPE"), name: "A2" });
    await flush();
    expect(reg.get("a")?.name).toBe("A2");
    expect(reg.match({ alert: workflowAlert(), event: workflowEvent() }).map((r) => r.id)).toEqual(["b"]);
    await store.emit("b");
    await flush();
    expect(reg.get("b")).toBeUndefined();

    await reg.close();
    expect(store.handlers.size).toBe(0);
  });
});
