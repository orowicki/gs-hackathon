#!/usr/bin/env node
// Local (no docker) stack: app + N workers (ingest parse worker + engine).
// Prints "ready" on stdout once /health is 200. Child logs go to stderr.
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const argv = process.argv.slice(2);
const wi = argv.indexOf("--workers");
const workers = wi >= 0 ? Number(argv[wi + 1]) : 1;
if (!Number.isInteger(workers) || workers < 0) {
  console.error("local-stack: --workers must be a non-negative integer");
  process.exit(2);
}
const port = process.env.LOADTEST_PORT ?? "3000";
const base = { ...process.env, NTFY_URL: process.env.NTFY_URL ?? "http://127.0.0.1:9" };

const children = [];
let stopping = false;

function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (c.exitCode === null) c.kill("SIGTERM");
  const t = setTimeout(() => {
    for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
    process.exit(code);
  }, 5000);
  const check = setInterval(() => {
    if (children.every((c) => c.exitCode !== null || c.signalCode !== null)) {
      clearTimeout(t);
      clearInterval(check);
      process.exit(code);
    }
  }, 100);
}

function start(name, script, env) {
  const child = spawn("node", [resolve(root, script)], {
    cwd: root,
    env: { ...base, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pipe = (stream) => {
    let buf = "";
    stream.on("data", (d) => {
      buf += d;
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const l of lines) process.stderr.write(`[${name}] ${l}\n`);
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);
  child.on("exit", (code, sig) => {
    if (!stopping) {
      console.error(`local-stack: ${name} died (code=${code} signal=${sig})`);
      stop(1);
    }
  });
  children.push(child);
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
process.on("exit", () => {
  for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
});

start("app", "packages/api/dist/main.js", {
  PORT: port,
  CONFIG_DIR: resolve(root, "config"),
});
for (let i = 1; i <= workers; i++) {
  start(`ingest-${i}`, "packages/ingest/dist/main.js", { WORKER_CONSUMER: `lt-parse-${i}` });
  start(`engine-${i}`, "packages/engine/dist/main.js", {});
}

const deadline = Date.now() + 60_000;
while (!stopping && Date.now() < deadline) {
  try {
    const r = await fetch(`http://localhost:${port}/health`);
    if (r.status === 200) {
      console.log("ready");
      break;
    }
  } catch {
    // not up yet
  }
  await new Promise((r) => setTimeout(r, 500));
}
if (!stopping && Date.now() >= deadline) {
  console.error("local-stack: /health not 200 within 60 s");
  stop(1);
}
