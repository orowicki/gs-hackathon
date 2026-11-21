// End-to-end load test: HTTP ingest -> parse worker -> engine -> alert (stream + UI push) / notification.
// See scripts/loadtest/README.md. Usage: node scripts/loadtest/run.mjs --rate 5000 --duration 60 [--smoke]
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createConfigStore } from "@alerting/config";
import { Redis } from "ioredis";
import pg from "pg";
import { writeChart } from "./chart.mjs";
import { TMP_PREFIX, purgeLoadtestData } from "./cleanup.mjs";
import {
  aggregateRuns,
  evaluateTargets,
  perSecondSeries,
  summarize,
} from "./stats.mjs";

const STREAM_EVENTS = "alerting:events";
const STREAM_ALERTS = "alerting:alerts";
const CHANNEL_UI_PUSH = "alerting:ui:push";
const STREAM_RAW = "alerting:events:raw";
const GROUP_PARSE = "parse";
const GROUP_ENGINE = "engine";
const QUEUE_DELIVERY = "alerting:delivery:queue";
const QUEUE_DELIVERY_PROCESSING = "alerting:delivery:processing";
const PREFLIGHT_THRESHOLD = 100;
// Temporary entities carry this prefix plus the run id; stale ones from crashed runs are deleted at start.
const ids = (runId) => ({
  source: `${TMP_PREFIX}${runId}`,
  person: `${TMP_PREFIX}bot-${runId}`,
  rule: `${TMP_PREFIX}rule-${runId}`,
  schema: `${TMP_PREFIX}schema-${runId}`,
});
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
  "lost = events accepted (HTTP 202) with no alert observed after the drain (parse + engine backlog excluded). " +
  "backlog.delivery = notifications still in the delivery queue plus the per-worker processing lists (retry zset excluded: scheduled future work); " +
  "backlog.deliveryWorker says whether a live delivery worker (heartbeat key) was found; without one the delivery backlog is recorded but ignored by the gates. " +
  "it is counted in backlogAtEnd and a delivery backlog above the threshold marks the window overloaded, but never in lost (it counts notifications, not events).";

export function parseArgs(argv, env = process.env, now = new Date()) {
  const o = {
    rate: 5000,
    duration: 60,
    workers: 1,
    smoke: false,
    chart: true,
    keepData: false,
    cleanupOnly: false,
    repeat: undefined,
    preflightTimeout: 600,
  };
  const num = (flag, v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0)
      throw new Error(`${flag} needs a positive number`);
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
    else if (a === "--config-dir")
      next(); // accepted and ignored (config goes straight into the store)
    else if (a === "--out") o.out = next();
    else if (a === "--smoke") o.smoke = true;
    else if (a === "--keep-data") o.keepData = true;
    else if (a === "--cleanup-only") o.cleanupOnly = true;
    else if (a === "--preflight-timeout") o.preflightTimeout = num(a, next());
    else if (a === "--repeat") o.repeat = Math.floor(num(a, next()));
    else if (a === "--repeat-keys") o.repeatKeys = Math.floor(num(a, next()));
    else if (a === "--no-chart") o.chart = false;
    else throw new Error(`unknown argument ${a}`);
  }
  if (o.smoke) {
    o.rate = 200;
    o.duration = 5;
  }
  o.repeat ??= o.smoke ? 1 : 3;
  o.baseUrl ??= env.BASE_URL || "http://localhost:3000";
  o.redis ??= env.REDIS_URL || "redis://localhost:6379";
  o.databaseUrl ??= env.DATABASE_URL;
  const date = now.toISOString().slice(0, 10);
  o.out ??= `results/${o.smoke ? "smoke/" : ""}loadtest-${date}${o.workers > 1 ? `-workers${o.workers}` : ""}.json`;
  return o;
}

/** Identical events (one dedup key): the temporary schema maps them all to the same common.dedupKey. */
export function buildRepeatBatch(runId, firstSeq, count, ts, rkey = "events") {
  const out = [];
  for (let i = 0; i < count; i++)
    out.push({
      run: `${runId}rk`,
      rkey,
      repeat: true,
      seq: firstSeq + i,
      ts,
      message: `loadtest ${runId} repeat`,
    });
  return out;
}

/** Dedup key the temporary schema gives repeat events with `rkey` ("events" = measured, "probe"). */
export function repeatDedupKey(runId, rkey) {
  return `${TMP_PREFIX}rk-${runId}-${rkey}`;
}

/** repeat-keys verdict: every measured event accepted and folded into exactly one alert of the measured key. */
export function repeatKeysOk({ events, accepted, alerts, count }) {
  return accepted === events && alerts === 1 && count === events;
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

export function entities(runId) {
  const { source: SOURCE_ID, person: PERSON_ID, rule: RULE_ID } = ids(runId);
  const stamp = "2026-11-01T00:00:00Z";
  return {
    source: {
      id: SOURCE_ID,
      name: "Load test (temporary)",
      type: "http",
      enabled: true,
      parser: { type: "json" },
      config: {},
    },
    // only matches the repeat-keys events; dedupKey from their `rkey` field, so the measured events fold into one
    // alert and the schema-liveness probes into another (the measured count is exact)
    schema: {
      id: ids(runId).schema,
      name: `Load test repeat keys (temporary, ${runId})`,
      match: `run matches "${runId}rk*"`,
      mapping: {
        dedupKey: { kind: "template", template: repeatDedupKey(runId, "{{rkey}}") },
        title: { kind: "constant", value: "loadtest repeat" },
      },
    },
    person: {
      id: PERSON_ID,
      name: "Load test bot",
      role: "temporary",
      canCreateRules: false,
    },
    rule: {
      id: RULE_ID,
      name: `Load test (temporary, ${runId})`,
      enabled: true,
      when: `run matches "${runId}*"`,
      who: [{ recipients: [{ type: "person", id: PERSON_ID }], force: ["ui"] }],
      looks: { titleTemplate: "loadtest", fields: [] },
      createdAt: stamp,
      updatedAt: stamp,
    },
  };
}

/** Remove temporary config entries (ids created by this script) left over from crashed earlier runs. */
async function purgeStaleConfig(store) {
  let n = 0;
  for (const kind of ["rule", "source", "person", "schema"]) {
    for (const x of await store.list(kind)) {
      if (String(x.id).startsWith(TMP_PREFIX)) {
        await store.delete(kind, x.id);
        n++;
      }
    }
  }
  return n;
}

/** Upsert the temporary source, person and rule into the config store; returns an async cleanup. */
async function installConfig(store, runId, withSchema = false) {
  const e = entities(runId);
  await purgeStaleConfig(store);
  const undo = async () => {
    for (const [kind, entity] of [
      ["rule", e.rule],
      ["source", e.source],
      ["person", e.person],
      ["schema", e.schema],
    ]) {
      try {
        await store.delete(kind, entity.id);
      } catch (err) {
        console.error(
          `loadtest: could not delete ${kind} ${entity.id}: ${err.message}`,
        );
      }
    }
  };
  try {
    await store.upsert("person", e.person);
    await store.upsert("source", e.source);
    await store.upsert("rule", e.rule);
    if (withSchema) await store.upsert("schema", e.schema);
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
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
          },
          timeout: 15000,
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            let accepted;
            try {
              accepted = JSON.parse(
                Buffer.concat(chunks).toString("utf8"),
              ).accepted;
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

/** XINFO GROUPS reply (array of flat key/value arrays) -> {name: {lag, pending, entriesRead}}. */
export function parseGroups(reply) {
  const out = {};
  for (const g of reply ?? []) {
    const o = {};
    for (let i = 0; i + 1 < g.length; i += 2) o[g[i]] = g[i + 1];
    out[o.name] = {
      lag: o.lag ?? null,
      pending: Number(o.pending ?? 0),
      entriesRead: o["entries-read"] ?? null,
    };
  }
  return out;
}

/** Queued work of one group: lag (undelivered) + pending (delivered, not acked). A missing group has none. */
export function groupBacklog(group, entriesAdded) {
  if (!group) return 0;
  let lag = group.lag;
  if (lag === null || lag === undefined) {
    // Redis could not compute the lag (stream was trimmed or deleted entries): estimate from the counters
    lag =
      group.entriesRead !== null && entriesAdded !== null
        ? Math.max(0, entriesAdded - group.entriesRead)
        : 0;
  }
  return Number(lag) + group.pending;
}

async function streamBacklog(conn, stream, group) {
  let groups;
  try {
    groups = parseGroups(await conn.xinfo("GROUPS", stream));
  } catch (e) {
    if (String(e.message).includes("no such key")) return 0;
    throw e;
  }
  const g = groups[group];
  let added = null;
  if (g && (g.lag === null || g.lag === undefined)) {
    const info = await conn.xinfo("STREAM", stream);
    const i = info.indexOf("entries-added");
    added = i >= 0 ? Number(info[i + 1]) : null;
  }
  return groupBacklog(g, added);
}

/** Queued events in the parse and engine groups, plus queued notifications in the delivery queue. */
export async function readBacklog(conn) {
  const [parse, engine, delivery, deliveryWorker] = await Promise.all([
    streamBacklog(conn, STREAM_RAW, GROUP_PARSE),
    streamBacklog(conn, STREAM_EVENTS, GROUP_ENGINE),
    deliveryBacklog(conn),
    deliveryWorkerLive(conn),
  ]);
  // without a live delivery worker nobody consumes the queue, so it must not gate idle/drain/overload
  return {
    parse,
    engine,
    delivery,
    deliveryWorker,
    total: parse + engine + (deliveryWorker ? delivery : 0),
  };
}

/** True when at least one registered delivery worker has a live heartbeat key. */
async function deliveryWorkerLive(conn) {
  const workers = await conn.smembers(`${QUEUE_DELIVERY_PROCESSING}:workers`);
  const alive = await Promise.all(
    workers.map((w) => conn.exists(`${QUEUE_DELIVERY_PROCESSING}:${w}:alive`)),
  );
  return alive.some((n) => n === 1);
}

/** Delivery backlog that gates idle/drain/overload: 0 when no live delivery worker exists. */
export function gatingDelivery(b) {
  return b.deliveryWorker ? b.delivery : 0;
}

/** Notifications queued for delivery: main queue + every worker's processing list + legacy list (not the retry zset). */
async function deliveryBacklog(conn) {
  const workers = await conn.smembers(`${QUEUE_DELIVERY_PROCESSING}:workers`);
  const keys = [
    QUEUE_DELIVERY,
    QUEUE_DELIVERY_PROCESSING,
    ...workers.map((w) => `${QUEUE_DELIVERY_PROCESSING}:${w}`),
  ];
  const lens = await Promise.all(keys.map((k) => conn.llen(k)));
  return lens.reduce((a, b) => a + b, 0);
}

/** Wait until both groups are (nearly) idle; throws after timeoutMs. Never touches the streams. */
async function waitForIdle(conn, timeoutMs, label) {
  const start = Date.now();
  let lastLog = 0;
  let warnedNoWorker = false;
  for (;;) {
    const b = await readBacklog(conn);
    if (
      b.parse <= PREFLIGHT_THRESHOLD &&
      b.engine <= PREFLIGHT_THRESHOLD &&
      gatingDelivery(b) <= PREFLIGHT_THRESHOLD
    )
      return Date.now() - start;
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `${label}: pipeline did not become idle within ${Math.round(timeoutMs / 1000)} s (parse backlog ${b.parse}, engine backlog ${b.engine}, delivery backlog ${b.delivery}). ` +
          "Wait for the workers to catch up or raise --preflight-timeout; streams are left untouched.",
      );
    }
    if (!b.deliveryWorker && b.delivery > 0 && !warnedNoWorker) {
      warnedNoWorker = true;
      console.error(
        `loadtest: warning: no live delivery worker, ignoring the delivery backlog (${b.delivery} notifications) in idle/drain/overload checks`,
      );
    }
    if (Date.now() - lastLog >= 10_000) {
      console.error(
        `loadtest: ${label}: waiting for backlog to drain (parse ${b.parse}, engine ${b.engine}, delivery ${b.delivery})`,
      );
      lastLog = Date.now();
    }
    await sleep(1000);
  }
}

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
    if (
      seq !== undefined &&
      seq >= 0 &&
      alertStreamByEvent.has(eventId) &&
      !counted.has(eventId)
    ) {
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
        if (m.type === "alert" && !pushMs.has(m.alertId))
          pushMs.set(m.alertId, now);
        else if (m.type === "notification" && m.notification) {
          const t = Date.parse(m.notification.createdAt);
          if (!notifMs.has(m.notification.alertId) && Number.isFinite(t))
            notifMs.set(m.notification.alertId, t);
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
        if (
          typeof e?.parsed?.run === "string" &&
          e.parsed.run.startsWith(runId) &&
          typeof e.parsed.seq === "number"
        ) {
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
    probeSeen: () =>
      [...alertEvent.values()].some((eid) => (eventSeq.get(eid) ?? 0) < 0),
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
  let probeConn;
  const cleanExit = async (code) => {
    await cleanup();
    probeConn?.disconnect();
    await store?.close().catch(() => {});
    process.exit(code);
  };
  process.on("SIGINT", () => cleanExit(130));
  process.on("SIGTERM", () => cleanExit(143));

  if (opts.cleanupOnly) {
    const redis = new Redis(opts.redis, { maxRetriesPerRequest: 3 });
    const st = createConfigStore({
      databaseUrl: opts.databaseUrl,
      redisUrl: opts.redis,
    });
    try {
      console.error(
        `loadtest: removed ${await purgeStaleConfig(st)} stale config entries`,
      );
      await purgeLoadtestData({ redis, databaseUrl: opts.databaseUrl });
    } catch (e) {
      console.error(`loadtest cleanup failed: ${e.message}`);
      process.exit(1);
    } finally {
      redis.disconnect();
      await st.close().catch(() => {});
    }
    process.exit(0);
  }

  const collector = createCollector(opts.redis, runId);
  const sourceId = ids(runId).source;
  const post = makePoster(opts.baseUrl, sourceId, 16);
  let result;
  let phase = "setup";
  try {
    probeConn = new Redis(opts.redis, { maxRetriesPerRequest: 3 });
    probeConn.on("error", () => {});
    phase = "preflight";
    const waited = await waitForIdle(
      probeConn,
      opts.preflightTimeout * 1000,
      "preflight",
    );
    if (waited > 2000)
      console.error(
        `loadtest: preflight waited ${Math.round(waited / 1000)} s for the existing backlog`,
      );
    phase = "setup";
    store = createConfigStore({
      databaseUrl: opts.databaseUrl,
      redisUrl: opts.redis,
    });
    if (!opts.keepData)
      await purgeLoadtestData({
        redis: probeConn,
        databaseUrl: opts.databaseUrl,
      });
    const undoConfig = await installConfig(store, runId, !!opts.repeatKeys);
    cleanup = async () => {
      await undoConfig();
      if (!opts.keepData)
        await purgeLoadtestData({
          redis: probeConn,
          databaseUrl: opts.databaseUrl,
        }).catch((e) =>
          console.error(`loadtest: data purge failed: ${e.message}`),
        );
    };
    await collector.start();

    // wait for source + rule to be live: probes (seq < 0) until one produces an alert
    const deadline = Date.now() + 30_000;
    let probeSeq = -1;
    for (;;) {
      if (Date.now() > deadline)
        throw new Error(
          "source/rule did not become live within 30 s (are the app, ingest worker and engine running on the same database and Redis?)",
        );
      const r = await post(
        JSON.stringify(buildBatch(runId, probeSeq--, 1, Date.now())),
      );
      if (r.status === 202 && collector.probeSeen()) break;
      await sleep(r.status === 202 ? 250 : 500);
    }
    await sleep(500); // let probe leftovers settle

    phase = "measurement";
    const runs = [];
    let seqBase = 0;
    for (let k = 1; k <= opts.repeat; k++) {
      phase = "preflight";
      await waitForIdle(
        probeConn,
        opts.preflightTimeout * 1000,
        `window ${k}/${opts.repeat} preflight`,
      );
      phase = "measurement";
      console.error(`loadtest: measurement window ${k}/${opts.repeat}`);
      const r = await measure(
        opts,
        `${runId}w${k}`,
        post,
        collector,
        seqBase,
        probeConn,
      );
      seqBase += r.sent;
      runs.push(r);
      if (r.overloaded) {
        console.error(
          `loadtest: window ${k} did not drain within the cap (unprocessed ${r.unprocessedAtEnd}, backlog ${r.backlogAtEnd}): overloaded, skipping the remaining ${opts.repeat - k} window(s)`,
        );
        break;
      }
    }
    result = aggregateRuns(runs, opts.repeat);
    if (opts.repeatKeys) {
      phase = "repeat-keys";
      await waitForIdle(
        probeConn,
        opts.preflightTimeout * 1000,
        "repeat-keys preflight",
      );
      result.repeatKeys = await runRepeatKeys(opts, runId, post);
      console.error(
        `loadtest: repeat-keys ${JSON.stringify(result.repeatKeys)}`,
      );
      if (!result.repeatKeys.ok)
        result.targets = { ...result.targets, met: false };
    }
  } catch (e) {
    console.error(`loadtest ${phase} failed: ${e.stack ?? e.message}`);
    await collector.stop();
    await cleanExit(1);
    return;
  }
  await collector.stop();
  await cleanup();
  probeConn?.disconnect();
  await store.close().catch(() => {});

  mkdirSync(dirname(resolve(opts.out)), { recursive: true });
  writeFileSync(opts.out, JSON.stringify(result, null, 2) + "\n");
  if (opts.chart)
    writeChart(opts.out.replace(/\.json$/, "") + ".html", [opts.out]);
  const e = result.latencyMs.e2e;
  console.log(
    `sent=${result.sent} accepted=${result.accepted} alertsSeen=${result.alertsSeen} p50=${e.p50}ms p99=${e.p99}ms lost=${result.lost} backlogAtEnd=${result.backlogAtEnd} overloaded=${result.overloaded} targetsMet=${result.targets.met} -> ${opts.out}`,
  );
  process.exit(0);
}

/**
 * Send `opts.repeatKeys` identical events (one dedup key) and check Postgres: exactly one alert with
 * count == events. Events go in batches of 50 so the stream order is the send order.
 */
/**
 * Schema propagation is async (config change -> every ingest worker). Send single repeat events until
 * an alert with the schema's constant dedup key shows up in Postgres, which proves the schema is live.
 * Probes carry their own dedup key, so they never add to the measured alert. Returns how many were sent.
 */
async function waitForSchema(pool, ruleId, key, runId, post) {
  const deadline = Date.now() + 30_000;
  let probes = 0;
  for (;;) {
    const r = await post(
      JSON.stringify(buildRepeatBatch(runId, -1 - probes, 1, Date.now(), "probe")),
    );
    if (r.status === 202 && Number.isFinite(r.accepted) && r.accepted >= 1)
      probes++;
    await sleep(500);
    const q = await pool.query(
      "SELECT 1 FROM alerts WHERE rule_id = $1 AND dedup_key = $2",
      [ruleId, key],
    );
    if (q.rowCount > 0) return probes;
    if (Date.now() > deadline)
      throw new Error("repeat-keys: temporary schema not live within 30 s");
  }
}

async function runRepeatKeys(opts, runId, post) {
  const events = opts.repeatKeys;
  const ruleId = ids(runId).rule;
  const key = repeatDedupKey(runId, "events");
  const pool = new pg.Pool({ connectionString: opts.databaseUrl, max: 1 });
  let probes = 0;
  let accepted = 0;
  try {
    probes = await waitForSchema(pool, ruleId, repeatDedupKey(runId, "probe"), runId, post);
  } catch (err) {
    await pool.end();
    throw err;
  }
  for (let sent = 0; sent < events;) {
    const n = Math.min(50, events - sent);
    const r = await post(
      JSON.stringify(buildRepeatBatch(runId, sent, n, Date.now())),
    );
    if (r.status !== 202)
      throw new Error(`repeat-keys: ingest answered ${r.status}`);
    if (!Number.isFinite(r.accepted))
      throw new Error("repeat-keys: ingest response has no accepted count");
    accepted += Math.min(r.accepted, n);
    sent += n;
  }
  let alerts = 0;
  let count = 0;
  try {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const r = await pool.query(
        "SELECT count(*)::int AS alerts, COALESCE(sum((data->>'count')::int), 0)::int AS count FROM alerts WHERE rule_id = $1 AND dedup_key = $2",
        [ruleId, key],
      );
      alerts = r.rows[0].alerts;
      count = r.rows[0].count;
      if (count >= accepted || Date.now() > deadline) break;
      await sleep(250);
    }
  } finally {
    await pool.end();
  }
  return {
    events,
    probes,
    accepted,
    alerts,
    count,
    ok: repeatKeysOk({ events, accepted, alerts, count }),
  };
}

async function measure(opts, runId, post, collector, seqBase = 0, probeConn) {
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
  let seq = seqBase;
  const seenBase = collector.seen();

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
          ? Number.isFinite(r.accepted)
            ? Math.min(r.accepted, count)
            : count
          : Number.isFinite(r.accepted)
            ? Math.min(r.accepted, count)
            : 0;
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
    if (owed > 0 && inflight < maxInflight)
      fire(
        Math.min(
          owed,
          Math.max(1, Math.ceil((opts.rate * batchMs * 4) / 1000)),
        ),
      );
    await sleep(batchMs);
  }
  const sendEnd = Date.now();
  while (inflight > 0 && Date.now() < sendEnd + 15_000) await sleep(20);

  // drain: all accepted seqs seen and the delivery backlog <= threshold, or no progress for 10 s, cap 60 s
  const drainStart = Date.now();
  let lastProgress = drainStart;
  let lastCount = -1;
  let lastDelivery = Infinity;
  for (;;) {
    const seen = collector.seen() - seenBase;
    const delivery = (await deliveryWorkerLive(probeConn))
      ? await deliveryBacklog(probeConn)
      : 0;
    if (seen >= okSeqs.length && delivery <= PREFLIGHT_THRESHOLD) break;
    if (seen !== lastCount || delivery < lastDelivery) {
      lastCount = seen;
      lastDelivery = delivery;
      lastProgress = Date.now();
    }
    if (Date.now() - lastProgress > 10_000 || Date.now() - drainStart > 60_000)
      break;
    await sleep(1000);
  }
  await sleep(500); // let trailing pushes arrive
  const backlog = await readBacklog(probeConn);
  const drained =
    collector.seen() - seenBase >= okSeqs.length &&
    gatingDelivery(backlog) <= PREFLIGHT_THRESHOLD;
  if (!backlog.deliveryWorker && backlog.delivery > 0)
    console.error(
      `loadtest: warning: no live delivery worker, delivery backlog ${backlog.delivery} not counted in backlogAtEnd/overload`,
    );

  const { bySeq, pushMs, notifMs, streamMs } = collector.resolve();
  const e2e = [];
  const notif = [];
  const stream = [];
  const processedTimes = [];
  let alertsSeen = 0;
  for (const s of okSeqs) {
    const alertId = bySeq.get(s);
    if (alertId === undefined) continue;
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
  if (processedTimes.length === 0)
    for (const s of okSeqs)
      if (streamMs.has(s)) processedTimes.push(streamMs.get(s));
  let lastProcessed = processedTimes.length ? 0 : sendEnd;
  for (const t of processedTimes) if (t > lastProcessed) lastProcessed = t;
  const sendSecs = Math.max(0.001, (sendEnd - startMs) / 1000);
  const procSecs = Math.max(0.001, (lastProcessed - startMs) / 1000);
  const e2eSummary = summarize(e2e.length ? e2e : stream);
  const unprocessedAtEnd = okSeqs.length - alertsSeen;
  const backlogAtEnd = backlog.total;
  // events still queued in the parse/engine groups are not lost, only late (delivery counts notifications, not events)
  const lost = Math.max(0, unprocessedAtEnd - backlog.parse - backlog.engine);
  const e2eCoverage =
    alertsSeen > 0 && e2e.length > 0
      ? Math.round((e2e.length / alertsSeen) * 10000) / 10000
      : 0;
  const round = (v) => Math.round(v * 10) / 10;

  let commit = null;
  try {
    commit = execSync("git rev-parse --short HEAD", {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    })
      .toString()
      .trim();
  } catch {
    /* not a git checkout */
  }
  return {
    date: new Date().toISOString(),
    commit,
    wallTimeSec: Math.round((Date.now() - startMs) / 10) / 100,
    config: {
      rate: opts.rate,
      duration: opts.duration,
      workers: opts.workers,
      smoke: opts.smoke,
      note: WORKERS_NOTE,
    },
    sent,
    accepted,
    rejected,
    httpErrors,
    alertsSeen,
    unprocessedAtEnd,
    backlogAtEnd,
    backlog,
    overloaded: !drained,
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
    targets: {
      ...evaluateTargets(e2eSummary, lost, e2eCoverage >= 1, backlogAtEnd),
      met:
        drained &&
        evaluateTargets(e2eSummary, lost, e2eCoverage >= 1, backlogAtEnd).met,
    },
    measurement: MEASUREMENT,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
