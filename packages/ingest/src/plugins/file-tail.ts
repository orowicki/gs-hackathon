import { watch, type FSWatcher } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
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
  /** Byte offset of the first unconsumed byte (start of the next line to emit). */
  offset: number;
  ino: number;
  dev: number;
}

/** Split a path/glob into a literal base directory and a glob pattern (null when no glob chars). */
function splitGlob(p: string): { base: string; pattern: string | null } {
  if (!picomatch.scan(p).isGlob)
    return { base: path.dirname(p), pattern: null };
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
    const isMatch = pattern
      ? (f: string) => pm(f)
      : (f: string) => f === target;
    const recursive =
      pattern !== null && path.relative(base, pattern).includes(path.sep);
    const states = new Map<string, FileState>();
    let stopped = false;
    let running = false;
    let again = false;
    let first = true;

    const readFile = async (file: string, st: FileState): Promise<void> => {
      let size: number;
      try {
        const info = await stat(file);
        size = info.size;
        if (info.ino !== st.ino || info.dev !== st.dev || size < st.offset) {
          // rotated (rename + recreate) or truncated: start over from the beginning
          st.ino = info.ino;
          st.dev = info.dev;
          st.offset = 0;
        }
      } catch {
        states.delete(file);
        return;
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
        const data = chunk.subarray(0, n);
        let pos = 0;
        let idx: number;
        while ((idx = data.indexOf(10, pos)) !== -1) {
          const text = data.toString("utf8", pos, idx).replace(/\r$/, "");
          if (text !== "") {
            if (stopped) return;
            try {
              await emit(text);
            } catch (e) {
              ctx.logger?.error(
                `file_tail emit failed (will retry): ${String(e)}`,
              );
              return; // offset stays at this line; retried next tick
            }
          }
          st.offset += idx + 1 - pos;
          pos = idx + 1;
        }
        if (pos === 0) {
          if (n < MAX_READ) break; // incomplete last line: wait for the rest
          // a single line longer than MAX_READ: emit it in pieces rather than stall
          if (stopped) return;
          try {
            await emit(data.toString("utf8"));
          } catch (e) {
            ctx.logger?.error(
              `file_tail emit failed (will retry): ${String(e)}`,
            );
            return;
          }
          st.offset += n;
        }
      }
    };

    const scan = async (): Promise<void> => {
      const files = (await listFiles(base, recursive)).filter(isMatch);
      for (const file of files) {
        let st = states.get(file);
        if (!st) {
          let info;
          try {
            info = await stat(file);
          } catch {
            continue;
          }
          st = { offset: first ? info.size : 0, ino: info.ino, dev: info.dev };
          states.set(file, st);
        }
        await readFile(file, st);
      }
      for (const f of [...states.keys()])
        if (!files.includes(f)) states.delete(f);
      first = false;
    };

    let inflight: Promise<void> = Promise.resolve();
    const tick = (): Promise<void> => {
      if (stopped) return Promise.resolve();
      if (running) {
        again = true;
        return inflight;
      }
      running = true;
      inflight = runScans();
      return inflight;
    };
    const runScans = async (): Promise<void> => {
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
        await inflight;
        watcher?.close();
        ctx.signal?.removeEventListener("abort", onAbort);
      },
    };
    return handle;
  },
};
