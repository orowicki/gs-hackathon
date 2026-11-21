import { afterEach, describe, expect, it } from "vitest";
import { handleHttpIngest, httpPlugin, registerBuiltinPlugins, getSourcePlugin, splitHttpBody } from "../src/index.js";

describe("splitHttpBody", () => {
  it("single object", () => expect(splitHttpBody('{"a":1}')).toEqual([{ a: 1 }]));
  it("array", () => expect(splitHttpBody('[{"a":1},"x",2]')).toEqual([{ a: 1 }, '"x"', "2"]));
  it("ndjson", () => expect(splitHttpBody('{"a":1}\n\n{"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }]));
  it("garbage line in ndjson", () => expect(splitHttpBody('{"a":1}\nhello world\n')).toEqual([{ a: 1 }, "hello world"]));
  it("plain text lines", () => expect(splitHttpBody("a\r\nb\n")).toEqual(["a", "b"]));
  it("empty", () => expect(splitHttpBody("  \n")).toEqual([]));
});

describe("http registry", () => {
  afterEach(() => undefined);
  it("unknown source", async () => expect(await handleHttpIngest("nope", "{}")).toEqual({ error: "unknown_source" }));
  it("accepts, rejects empty, and unregisters on stop", async () => {
    const got: unknown[] = [];
    const h = await httpPlugin.start({}, async (m) => void got.push(m), { sourceId: "s1" });
    expect(await handleHttpIngest("s1", '{"a":1}\nfoo')).toEqual({ accepted: 2 });
    expect(got).toEqual([{ a: 1 }, "foo"]);
    expect(await handleHttpIngest("s1", "")).toEqual({ error: "empty" });
    await h.stop();
    expect(await handleHttpIngest("s1", "{}")).toEqual({ error: "unknown_source" });
  });
  it("registerBuiltinPlugins", () => {
    registerBuiltinPlugins();
    for (const t of ["http", "file_tail", "redis_stream"]) expect(getSourcePlugin(t)).toBeDefined();
  });
});
