import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    handle = await fileTailPlugin.start({ path: path.join(dir, "*.log") }, emit, { sourceId: "s" });
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
});
