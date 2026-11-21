// Demo event generator: sends a mix of Appendix A events through http, file_tail and redis_stream.
// node --experimental-strip-types scripts/demo/demo.ts [--once] [--rate 2] [--duration 60] [--count N]
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nextEvent, oneOfEach, type DemoEvent } from "./events.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const API_URL = (process.env.API_URL ?? "http://localhost:3000").replace(/\/$/, "");
const STREAM = "demo:events";

type Sink = "http" | "file_tail" | "redis_stream";

function run(cmd: string, args: string[], input?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: ROOT, stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d: Buffer) => (err += d.toString()));
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} ${args.slice(0, 3).join(" ")} exited ${code}: ${err.trim().slice(0, 300)}`)),
    );
    p.stdin.end(input ?? "");
  });
}

async function sendHttp(line: string): Promise<void> {
  const r = await fetch(`${API_URL}/ingest/demo-http`, {
    method: "POST",
    // Junk lines are sent as plain text so the source's raw fallback handles them.
    headers: { "content-type": line.startsWith("{") ? "application/json" : "text/plain" },
    body: line,
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`HTTP ingest failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
}

async function sendFile(line: string): Promise<void> {
  const local = process.env.DEMO_LOG_FILE;
  if (local) {
    mkdirSync(dirname(local), { recursive: true });
    appendFileSync(local, line + "\n");
    return;
  }
  await run(
    "docker",
    ["compose", "exec", "-T", "app", "sh", "-c", "mkdir -p /tmp/demo-logs && cat >> /tmp/demo-logs/demo.log"],
    line + "\n",
  );
}

async function makeRedisSender(): Promise<{ send: (line: string) => Promise<void>; close: () => void }> {
  const url = process.env.DEMO_REDIS_URL;
  if (url) {
    const { Redis } = await import("ioredis");
    const redis = new Redis(url);
    return { send: async (line) => void (await redis.xadd(STREAM, "*", "data", line)), close: () => redis.disconnect() };
  }
  return {
    send: (line) => run("docker", ["compose", "exec", "-T", "redis", "redis-cli", "XADD", STREAM, "*", "data", line]),
    close: () => undefined,
  };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function num(name: string, env: string, dflt: number): number {
  const v = Number(arg(name) ?? process.env[env] ?? dflt);
  if (!Number.isFinite(v) || v <= 0) throw new Error(`--${name} must be a positive number`);
  return v;
}

async function main(): Promise<void> {
  const once = process.argv.includes("--once");
  const rate = num("rate", "DEMO_RATE", 2);
  const duration = num("duration", "DEMO_DURATION", 60);
  const count = arg("count") !== undefined ? num("count", "DEMO_COUNT", 1) : Infinity;
  const redis = await makeRedisSender();
  const counts: Record<Sink, number> = { http: 0, file_tail: 0, redis_stream: 0 };
  const senders: Record<Sink, (l: string) => Promise<void>> = {
    http: sendHttp,
    file_tail: sendFile,
    redis_stream: redis.send,
  };
  const sinks = Object.keys(senders) as Sink[];
  const emit = async (sink: Sink, e: DemoEvent) => {
    await senders[sink](e.line);
    counts[sink]++;
  };
  try {
    if (once) {
      for (const sink of sinks) for (const e of oneOfEach(Math.random, new Date())) await emit(sink, e);
    } else {
      console.log(`demo: ~${rate} events/s for ${count === Infinity ? `${duration} s` : `${count} events`} (Ctrl-C to stop)`);
      const recent: DemoEvent[] = [];
      const end = Date.now() + duration * 1000;
      for (let i = 0; i < count && (count !== Infinity || Date.now() < end); i++) {
        const e = nextEvent(Math.random, new Date(), recent);
        recent.push(e);
        if (recent.length > 10) recent.shift();
        await emit(sinks[i % sinks.length] as Sink, e);
        await new Promise((r) => setTimeout(r, (1000 / rate) * (0.5 + Math.random())));
      }
    }
  } finally {
    redis.close();
  }
  console.log(
    `demo: sent ${counts.http} via http, ${counts.file_tail} via file_tail, ${counts.redis_stream} via redis_stream`,
  );
}

main().catch((e) => {
  console.error(`demo failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
