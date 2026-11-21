import {
  appendFileSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileTailPlugin, type SourceHandle } from "../src/index.js";

let dir: string;
let handle: SourceHandle | undefined;
let got: unknown[];
const emit = async (m: unknown) => void got.push(m);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(n: number, ms = 1000) {
  const end = Date.now() + ms;
  while (got.length < n && Date.now() < end) await sleep(25);
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "tail-"));
  got = [];
});
afterEach(async () => {
  await handle?.stop();
  handle = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe("file_tail", () => {
  it("skips existing content, emits appended lines, buffers partial lines", async () => {
    const f = path.join(dir, "a.log");
    writeFileSync(f, "old1\nold2\n");
    handle = await fileTailPlugin.start({ path: f }, emit, { sourceId: "s" });
    await sleep(400);
    expect(got).toEqual([]);
    appendFileSync(f, "new1\nnew");
    await waitFor(1);
    expect(got).toEqual(["new1"]);
    await sleep(400);
    expect(got).toEqual(["new1"]);
    appendFileSync(f, "2\n");
    await waitFor(2);
    expect(got).toEqual(["new1", "new2"]);
  });

  it("picks up new files matching a glob from the start", async () => {
    writeFileSync(path.join(dir, "x.log"), "existing\n");
    handle = await fileTailPlugin.start(
      { path: path.join(dir, "*.log") },
      emit,
      { sourceId: "s" },
    );
    writeFileSync(path.join(dir, "y.log"), "hello\nworld\n");
    writeFileSync(path.join(dir, "z.txt"), "ignored\n");
    await waitFor(2);
    expect(got).toEqual(["hello", "world"]);
  });

  it("handles truncation", async () => {
    const f = path.join(dir, "t.log");
    writeFileSync(f, "aaaaaaaaaaaaaaaa\n");
    handle = await fileTailPlugin.start({ path: f }, emit, { sourceId: "s" });
    appendFileSync(f, "bbbb\n");
    await waitFor(1);
    writeFileSync(f, "c\n");
    await waitFor(2);
    expect(got).toEqual(["bbbb", "c"]);
  });

  it("detects rotation (rename + recreate with a larger file) and reads the new file from 0", async () => {
    const f = path.join(dir, "r.log");
    writeFileSync(f, "a\n");
    handle = await fileTailPlugin.start({ path: f }, emit, { sourceId: "s" });
    renameSync(f, path.join(dir, "r.log.1"));
    writeFileSync(f, "new-one\nnew-two\nnew-three\n");
    await waitFor(3);
    expect(got).toEqual(["new-one", "new-two", "new-three"]);
  });

  it("retries a line whose emit failed on the next tick", async () => {
    const f = path.join(dir, "e.log");
    writeFileSync(f, "");
    let calls = 0;
    const flaky = async (m: unknown) => {
      if (++calls === 1) throw new Error("down");
      got.push(m);
    };
    handle = await fileTailPlugin.start({ path: f }, flaky, { sourceId: "s" });
    appendFileSync(f, "l1\nl2\n");
    await waitFor(2, 2000);
    expect(got).toEqual(["l1", "l2"]);
  });

  it("stop() awaits an in-flight emit; nothing emits afterwards", async () => {
    const f = path.join(dir, "s.log");
    writeFileSync(f, "");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started = false;
    const slow = async (m: unknown) => {
      started = true;
      await gate;
      got.push(m);
    };
    handle = await fileTailPlugin.start({ path: f }, slow, { sourceId: "s" });
    appendFileSync(f, "one\ntwo\n");
    const end = Date.now() + 2000;
    while (!started && Date.now() < end) await sleep(10);
    let stopped = false;
    const stopping = handle.stop().then(() => (stopped = true));
    await sleep(100);
    expect(stopped).toBe(false);
    release();
    await stopping;
    const n = got.length;
    await sleep(500);
    expect(got.length).toBe(n);
    expect(got).toEqual(["one"]);
    handle = undefined;
  });
});
