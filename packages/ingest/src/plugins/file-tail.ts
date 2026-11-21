import { watch, type FSWatcher } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import path from "node:path";
import picomatch from "picomatch";
import type { SourcePlugin } from "../types.js";
import { FILE_TAIL_CONFIG_SCHEMA } from "./schemas.js";

export interface FileTailConfig {
  path: string;
}

const POLL_MS = 250;
const MAX_READ = 1024 * 1024;

interface FileState {
  offset: number;
  decoder: StringDecoder;
  buf: string;
}

/** Split a path/glob into a literal base directory and a glob pattern (null when no glob chars). */
function splitGlob(p: string): { base: string; pattern: string | null } {
  if (!picomatch.scan(p).isGlob) return { base: path.dirname(p), pattern: null };
  const { base } = picomatch.scan(p);
  return { base: base === "" ? "." : base, pattern: p };
}

async function listFiles(base: string, recursive: boolean): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(base, e.name);
    if (e.isDirectory()) {
      if (recursive) out.push(...(await listFiles(full, true)));
    } else out.push(full);
  }
  return out;
}

/**
 * Tails a file or glob. Only lines appended after start are emitted for files that already
 * exist; files that appear later are read from the beginning. Glob supports `*`, `?`, `{a,b}`,
 * and `**` (directories are scanned recursively only when the pattern contains `**` or `/`
 * after the base directory). Detection uses fs.watch on the base directory plus a 250 ms poll.
 */
export const fileTailPlugin: SourcePlugin<FileTailConfig> = {
  type: "file_tail",
  configSchema: FILE_TAIL_CONFIG_SCHEMA,
  async start(config, emit, ctx) {
    const target = path.resolve(config.path);
    const { base, pattern } = splitGlob(target);
    const pm = pattern ? picomatch(pattern, { dot: true }) : () => false;
    const isMatch = pattern ? (f: string) => pm(f) : (f: string) => f === target;
    const recursive = pattern !== null && path.relative(base, pattern).includes(path.sep);
    const states = new Map<string, FileState>();
    let stopped = false;
    let running = false;
    let again = false;
    let first = true;

    const readFile = async (file: string, st: FileState): Promise<void> => {
      let size: number;
      try {
        size = (await stat(file)).size;
      } catch {
        states.delete(file);
        return;
      }
      if (size < st.offset) {
        st.offset = 0;
        st.buf = "";
        st.decoder = new StringDecoder("utf8");
      }
      while (st.offset < size && !stopped) {
        const len = Math.min(size - st.offset, MAX_READ);
        const fh = await open(file, "r");
        let n = 0;
        const chunk = Buffer.alloc(len);
        try {
          n = (await fh.read(chunk, 0, len, st.offset)).bytesRead;
        } finally {
          await fh.close();
        }
        if (n === 0) break;
        st.offset += n;
        st.buf += st.decoder.write(chunk.subarray(0, n));
        const parts = st.buf.split("\n");
        st.buf = parts.pop() ?? "";
        for (const line of parts) {
          const text = line.replace(/\r$/, "");
          if (text === "") continue;
          try {
            await emit(text);
          } catch (e) {
            ctx.logger?.error(`file_tail emit failed: ${String(e)}`);
          }
        }
      }
    };

    const scan = async (): Promise<void> => {
      const files = (await listFiles(base, recursive)).filter(isMatch);
      for (const file of files) {
        let st = states.get(file);
        if (!st) {
          let size = 0;
          try {
            size = first ? (await stat(file)).size : 0;
          } catch {
            continue;
          }
          st = { offset: size, decoder: new StringDecoder("utf8"), buf: "" };
          states.set(file, st);
        }
        await readFile(file, st);
      }
      for (const f of [...states.keys()]) if (!files.includes(f)) states.delete(f);
      first = false;
    };

    const tick = async (): Promise<void> => {
      if (stopped) return;
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        do {
          again = false;
          await scan();
        } while (again && !stopped);
      } catch (e) {
        ctx.logger?.error(`file_tail scan failed: ${String(e)}`);
      } finally {
        running = false;
      }
    };

    await scan(); // baseline: existing files start at EOF
    const timer = setInterval(() => void tick(), POLL_MS);
    let watcher: FSWatcher | undefined;
    try {
      watcher = watch(base, { recursive }, () => void tick());
      watcher.on("error", () => watcher?.close());
    } catch {
      // base dir missing or unsupported: polling covers it
    }
    const onAbort = () => void handle.stop();
    ctx.signal?.addEventListener("abort", onAbort, { once: true });

    const handle = {
      async stop() {
        stopped = true;
        clearInterval(timer);
        watcher?.close();
        ctx.signal?.removeEventListener("abort", onAbort);
      },
    };
    return handle;
  },
};
