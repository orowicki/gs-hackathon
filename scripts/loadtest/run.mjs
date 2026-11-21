// End-to-end load test: HTTP ingest -> parse worker -> engine -> alert (stream + UI push) / notification.
// See scripts/loadtest/README.md. Usage: node scripts/loadtest/run.mjs --rate 5000 --duration 60 [--smoke]
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createConfigStore } from "@alerting/config";
import { Redis } from "ioredis";
import { writeChart } from "./chart.mjs";
import { evaluateTargets, perSecondSeries, summarize } from "./stats.mjs";

const STREAM_EVENTS = "alerting:events";
const STREAM_ALERTS = "alerting:alerts";
const CHANNEL_UI_PUSH = "alerting:ui:push";
// Temporary entities carry this prefix plus the run id; stale ones from crashed runs are deleted at start.
const TMP_PREFIX = "lt-tmp-";
const ids = (runId) => ({ source: `${TMP_PREFIX}${runId}`, person: `${TMP_PREFIX}bot-${runId}`, rule: `${TMP_PREFIX}rule-${runId}` });
export const WORKERS_NOTE =
  "The api process runs an in-process ingest parse worker, so N workers means N engines and N+1 parse consumers (N standalone ingest workers plus the api's own).";

export const MEASUREMENT =
  "Each event has a unique seq and send timestamp (Date.now() in this process, same host clock assumed). " +
  "e2e = time this process receives the pub/sub UI push {type:alert,alertId} on alerting:ui:push minus the send time of the " +
  "event that produced the alert (alertId -> eventId from alerting:alerts, eventId -> seq from alerting:events). " +
  "alertStream = alerting:alerts stream-entry time (Redis server clock) minus send time. " +
  "notification = Notification.createdAt (enqueue time in the engine) minus send time, read from the ui-channel " +
  "{type:notification} push; null when no delivery worker is running. Send time is taken just before the HTTP batch is written, " +
  "so it includes HTTP, XADD, parse worker, Postgres insert, engine and pub/sub. Latency covers events whose alert was observed; " +
  "lost = events accepted (HTTP 202) with no alert observed after the drain.";

export function parseArgs(argv, env = process.env, now = new Date()) {
  const o = { rate: 5000, duration: 60, workers: 1, smoke: false, chart: true };
  const num = (flag, v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} needs a positive number`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--rate") o.rate = num(a, next());
    else if (a === "--duration") o.duration = num(a, next());
    else if (a === "--workers") o.workers = Math.floor(num(a, next()));
    else if (a === "--base-url") o.baseUrl = next();
    else if (a === "--redis") o.redis = next();
    else if (a === "--database-url") o.databaseUrl = next();
    else if (a === "--config-dir") next(); // accepted and ignored (config goes straight into the store)
    else if (a === "--out") o.out = next();
    else if (a === "--smoke") o.smoke = true;
    else if (a === "--no-chart") o.chart = false;
    else throw new Error(`unknown argument ${a}`);
  }
  if (o.smoke) {
    o.rate = 200;
    o.duration = 5;
  }
  o.baseUrl ??= env.BASE_URL || "http://localhost:3000";
  o.redis ??= env.REDIS_URL || "redis://localhost:6379";
  o.databaseUrl ??= env.DATABASE_URL;
  const date = now.toISOString().slice(0, 10);
  o.out ??= `results/loadtest-${date}${o.workers > 1 ? `-workers${o.workers}` : ""}.json`;
  return o;
}

/** Event payloads for one batch. Every event is unique (seq in message) so dedup cannot merge them. */
export function buildBatch(runId, firstSeq, count, ts) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const seq = firstSeq + i;
    out.push({ run: runId, seq, ts, message: `loadtest ${runId} #${seq}` });
  }
  return out;
}

function entities(runId) {
  const { source: SOURCE_ID, person: PERSON_ID, rule: RULE_ID } = ids(runId);
  const stamp = "2026-11-01T00:00:00Z";
  return {
    source: { id: SOURCE_ID, name: "Load test (temporary)", type: "http", enabled: true, parser: { type: "json" }, config: {} },
    person: { id: PERSON_ID, name: "Load test bot", role: "temporary", canCreateRules: false },
    rule: {
      id: RULE_ID,
      name: `Load test (temporary, ${runId})`,
      enabled: true,
      when: `run = "${runId}"`,
      who: [{ recipients: [{ type: "person", id: PERSON_ID }], force: ["ui"] }],
      looks: { titleTemplate: "loadtest", fields: [] },
      createdAt: stamp,
      updatedAt: stamp,
    },
  };
}

/** Upsert the temporary source, person and rule into the config store; returns an async cleanup. */
async function installConfig(store, runId) {
  const e = entities(runId);
  // remove leftovers of crashed earlier runs (only ids this script creates)
  for (const kind of ["rule", "source", "person"]) {
    for (const x of await store.list(kind)) if (String(x.id).startsWith(TMP_PREFIX)) await store.delete(kind, x.id);
  }
  const undo = async () => {
    for (const [kind, entity] of [["rule", e.rule], ["source", e.source], ["person", e.person]]) {
      try {
        await store.delete(kind, entity.id);
      } catch (err) {
        console.error(`loadtest: could not delete ${kind} ${entity.id}: ${err.message}`);
      }
    }
  };
  try {
    await store.upsert("person", e.person);
    await store.upsert("source", e.source);
    await store.upsert("rule", e.rule);
  } catch (err) {
    await undo();
    throw err;
  }
  return undo;
}

function makePoster(baseUrl, sourceId, maxSockets) {
  const url = new URL(baseUrl);
  const agent = new http.Agent({ keepAlive: true, maxSockets });
  return (body) =>
    new Promise((resolveP) => {
      const req = http.request(
        {
          agent,
          host: url.hostname,
          port: url.port || 80,
          path: `/ingest/${sourceId}`,
          method: "POST",
          headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
          timeout: 15000,
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            let accepted;
            try {
              accepted = JSON.parse(Buffer.concat(chunks).toString("utf8")).accepted;
            } catch {
              /* ignore */
            }
            resolveP({ status: res.statusCode ?? 0, accepted });
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", () => resolveP({ status: 0, accepted: undefined }));
      req.end(body);
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Collects the three observation streams. Seqs < 0 are probes. */
function createCollector(redisUrl, runId) {
  const eventSeq = new Map(); // eventId -> seq
  const alertEvent = new Map(); // alertId -> eventId
  const alertStreamByEvent = new Map(); // eventId -> redis stream ms
  const pushMs = new Map(); // alertId -> receive time
  const notifMs = new Map(); // alertId -> createdAt ms
  const counted = new Set(); // eventIds of this run (seq >= 0) with an alert
  let seenCount = 0;
  const tally = (eventId) => {
    const seq = eventSeq.get(eventId);
    if (seq !== undefined && seq >= 0 && alertStreamByEvent.has(eventId) && !counted.has(eventId)) {
      counted.add(eventId);
      seenCount++;
    }
  };
  const conns = [];
  let stopped = false;
  const mk = () => {
    const c = new Redis(redisUrl, { maxRetriesPerRequest: 3 });
    c.on("error", () => {});
    conns.push(c);
    return c;
  };

  async function readStream(conn, key, onEntry) {
    let id = "$";
    while (!stopped) {
      let res;
      try {
        res = await conn.xread("COUNT", 2000, "BLOCK", 500, "STREAMS", key, id);
      } catch {
        if (stopped) return;
        await sleep(200);
        continue;
      }
      if (!res) continue;
      for (const [eid, fields] of res[0][1]) {
        id = eid;
        const i = fields.indexOf("data");
        if (i < 0) continue;
        try {
          onEntry(eid, JSON.parse(fields[i + 1]));
        } catch {
          /* ignore */
        }
      }
    }
  }

  const sub = mk();
  const ready = sub.subscribe(CHANNEL_UI_PUSH).then(() => {
    sub.on("message", (_ch, msg) => {
      const now = Date.now();
      try {
        const m = JSON.parse(msg);
        if (m.type === "alert" && !pushMs.has(m.alertId)) pushMs.set(m.alertId, now);
        else if (m.type === "notification" && m.notification) {
          const t = Date.parse(m.notification.createdAt);
          if (!notifMs.has(m.notification.alertId) && Number.isFinite(t)) notifMs.set(m.notification.alertId, t);
        }
      } catch {
        /* ignore */
      }
    });
  });
  // Make sure the XREADs have started from "$" before the caller sends: resolve the current last ids first.
  const loops = [];
  const start = async () => {
    await ready;
    const ev = mk();
    const al = mk();
    loops.push(
      readStream(ev, STREAM_EVENTS, (eid, e) => {
        if (e?.parsed?.run === runId && typeof e.parsed.seq === "number") {
          eventSeq.set(e.id ?? eid, e.parsed.seq);
          tally(e.id ?? eid);
        }
      }),
      readStream(al, STREAM_ALERTS, (eid, a) => {
        alertEvent.set(a.alertId, a.eventId);
        alertStreamByEvent.set(a.eventId, Number(eid.split("-")[0]));
        tally(a.eventId);
      }),
    );
    await sleep(100);
  };

  return {
    start,
    seen: () => seenCount,
    probeSeen: () => [...alertEvent.values()].some((eid) => (eventSeq.get(eid) ?? 0) < 0),
    /** seq -> {alertId, ...} resolved lazily at the end */
    resolve() {
      const bySeq = new Map(); // seq -> alertId
      for (const [alertId, eventId] of alertEvent) {
        const seq = eventSeq.get(eventId);
        if (seq !== undefined) bySeq.set(seq, alertId);
      }
      const streamMs = new Map();
      for (const [eventId, ms] of alertStreamByEvent) {
        const seq = eventSeq.get(eventId);
        if (seq !== undefined) streamMs.set(seq, ms);
      }
      return { bySeq, pushMs, notifMs, streamMs };
    },
    async stop() {
      stopped = true;
      for (const c of conns) c.disconnect();
      await Promise.allSettled(loops);
    },
  };
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`loadtest: ${e.message}`);
    process.exit(2);
  }
  const runId = Date.now().toString(36);
  if (!opts.databaseUrl) {
    console.error("loadtest: --database-url or DATABASE_URL is required");
    process.exit(2);
  }
  let cleanup = async () => {};
  let store;
  const cleanExit = async (code) => {
    await cleanup();
    await store?.close().catch(() => {});
    process.exit(code);
  };
  process.on("SIGINT", () => cleanExit(130));
  process.on("SIGTERM", () => cleanExit(143));

  const collector = createCollector(opts.redis, runId);
  const sourceId = ids(runId).source;
  const post = makePoster(opts.baseUrl, sourceId, 16);
  let result;
  let phase = "setup";
  try {
    store = createConfigStore({ databaseUrl: opts.databaseUrl, redisUrl: opts.redis });
    cleanup = await installConfig(store, runId);
    await collector.start();

    // wait for source + rule to be live: probes (seq < 0) until one produces an alert
    const deadline = Date.now() + 30_000;
    let probeSeq = -1;
    for (;;) {
      if (Date.now() > deadline) throw new Error("source/rule did not become live within 30 s (are the app, ingest worker and engine running on the same database and Redis?)");
      const r = await post(JSON.stringify(buildBatch(runId, probeSeq--, 1, Date.now())));
      if (r.status === 202 && collector.probeSeen()) break;
      await sleep(r.status === 202 ? 250 : 500);
    }
    await sleep(500); // let probe leftovers settle

    phase = "measurement";
    result = await measure(opts, runId, post, collector);
  } catch (e) {
    console.error(`loadtest ${phase} failed: ${e.stack ?? e.message}`);
    await collector.stop();
    await cleanExit(1);
    return;
  }
  await collector.stop();
  await cleanup();
  await store.close().catch(() => {});

  mkdirSync(dirname(resolve(opts.out)), { recursive: true });
  writeFileSync(opts.out, JSON.stringify(result, null, 2) + "\n");
  if (opts.chart) writeChart(opts.out.replace(/\.json$/, "") + ".html", [opts.out]);
  const e = result.latencyMs.e2e;
  console.log(
    `sent=${result.sent} accepted=${result.accepted} alertsSeen=${result.alertsSeen} p50=${e.p50}ms p99=${e.p99}ms lost=${result.lost} targetsMet=${result.targets.met} -> ${opts.out}`,
  );
  process.exit(0);
}

async function measure(opts, runId, post, collector) {
  const batchMs = 10;
  const maxInflight = 32;
  const sendTs = new Map(); // seq -> ts
  const okSeqs = [];
  const sentTimes = [];
  let sent = 0;
  let accepted = 0;
  let rejected = 0;
  let httpErrors = 0;
  let inflight = 0;
  const startMs = Date.now();
  const endMs = startMs + opts.duration * 1000;
  let seq = 0;

  const fire = (count) => {
    const ts = Date.now();
    const batch = buildBatch(runId, seq, count, ts);
    const first = seq;
    seq += count;
    sent += count;
    for (let i = 0; i < count; i++) {
      sendTs.set(first + i, ts);
      sentTimes.push(ts);
    }
    inflight++;
    post(JSON.stringify(batch)).then((r) => {
      inflight--;
      const n =
        r.status === 202
          ? Number.isFinite(r.accepted) ? Math.min(r.accepted, count) : count
          : Number.isFinite(r.accepted) ? Math.min(r.accepted, count) : 0;
      accepted += n;
      for (let i = 0; i < n; i++) okSeqs.push(first + i);
      if (r.status === 0) httpErrors += count - n;
      else rejected += count - n;
    });
  };

  // timer loop: owed = rate * elapsed - sent; skipped while too many requests are in flight
  while (Date.now() < endMs) {
    const elapsed = (Date.now() - startMs) / 1000;
    const owed = Math.floor(opts.rate * elapsed) - sent;
    if (owed > 0 && inflight < maxInflight) fire(Math.min(owed, Math.max(1, Math.ceil(opts.rate * batchMs * 4 / 1000))));
    await sleep(batchMs);
  }
  const sendEnd = Date.now();
  while (inflight > 0 && Date.now() < sendEnd + 15_000) await sleep(20);

  // drain: all accepted seqs seen, or no progress for 10 s, cap 60 s
  const drainStart = Date.now();
  let lastProgress = drainStart;
  let lastCount = -1;
  for (;;) {
    const seen = collector.seen();
    if (seen >= okSeqs.length) break;
    if (seen !== lastCount) {
      lastCount = seen;
      lastProgress = Date.now();
    }
    if (Date.now() - lastProgress > 10_000 || Date.now() - drainStart > 60_000) break;
    await sleep(1000);
  }
  await sleep(500); // let trailing pushes arrive

  const { bySeq, pushMs, notifMs, streamMs } = collector.resolve();
  const e2e = [];
  const notif = [];
  const stream = [];
  const processedTimes = [];
  let alertsSeen = 0;
  let lost = 0;
  for (const s of okSeqs) {
    const alertId = bySeq.get(s);
    if (alertId === undefined) {
      lost++;
      continue;
    }
    alertsSeen++;
    const ts = sendTs.get(s);
    const push = pushMs.get(alertId);
    if (push !== undefined) {
      e2e.push(push - ts);
      processedTimes.push(push);
    }
    const sm = streamMs.get(s);
    if (sm !== undefined) stream.push(sm - ts);
    const n = notifMs.get(alertId);
    if (n !== undefined) notif.push(n - ts);
  }
  if (processedTimes.length === 0) for (const s of okSeqs) if (streamMs.has(s)) processedTimes.push(streamMs.get(s));
  let lastProcessed = processedTimes.length ? 0 : sendEnd;
  for (const t of processedTimes) if (t > lastProcessed) lastProcessed = t;
  const sendSecs = Math.max(0.001, (sendEnd - startMs) / 1000);
  const procSecs = Math.max(0.001, (lastProcessed - startMs) / 1000);
  const e2eSummary = summarize(e2e.length ? e2e : stream);
  const e2eCoverage = alertsSeen > 0 && e2e.length > 0 ? Math.round((e2e.length / alertsSeen) * 10000) / 10000 : 0;
  const round = (v) => Math.round(v * 10) / 10;

  let commit = null;
  try {
    commit = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).toString().trim();
  } catch {
    /* not a git checkout */
  }
  return {
    date: new Date().toISOString(),
    commit,
    config: { rate: opts.rate, duration: opts.duration, workers: opts.workers, smoke: opts.smoke, note: WORKERS_NOTE },
    sent,
    accepted,
    rejected,
    httpErrors,
    alertsSeen,
    lost,
    throughput: {
      targetRate: opts.rate,
      sendRate: round(sent / sendSecs),
      processedPerSec: round(alertsSeen / procSecs),
      perSecond: perSecondSeries(sentTimes, processedTimes, startMs),
    },
    latencyMs: {
      e2e: e2eSummary,
      e2eSource: e2e.length ? "ui-push" : "alert-stream",
      alertStream: summarize(stream),
      notification: notif.length ? summarize(notif) : null,
    },
    e2eCoverage,
    targets: evaluateTargets(e2eSummary, lost, e2eCoverage >= 1),
    measurement: MEASUREMENT,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
