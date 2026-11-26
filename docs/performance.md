# Performance

Load test results for the ingest to alert path against the SPEC targets: p50 < 50 ms, p99 < 250 ms, 0 lost events.

## Running the test

```sh
just loadtest                  # compose stack: 1 worker, then 2 workers (5000 ev/s for 60 s each)
just loadtest --local          # no docker: processes on the host, local Postgres and Redis
just loadtest --smoke          # short check: 5 s at 200 ev/s, 1 repeat, writes to results/smoke/
just loadtest --repeat N       # N measurement windows per configuration (default 3), reported as the median
just loadtest --workers N      # a single run with N workers instead of 1 then 2
just loadtest --rate R --duration S
just loadtest --repeat-keys N  # after the windows, send N identical events (one dedup key) and check they collapse into one alert with count N
```

Flags combine (for example `just loadtest --local --workers 2`). `--repeat-keys N` adds a dedup scenario: N identical events share one dedup key (through a temporary schema) and the run polls Postgres (60 s cap) for the alerts of that key; `repeatKeys: {events, probes, accepted, alerts, count, ok}` goes into the JSON and `ok` needs exactly one alert with `count == events`, otherwise `targets.met` is false. The windows themselves are unaffected.

The 1000 ev/s figure was produced with `just loadtest --local --workers 1 --rate 1000` and the output files were renamed to `loadtest-2026-11-21-rate1000.json`/`.html` so they do not overwrite the 5000 ev/s results. The 5000 ev/s runs used `--repeat-keys 500`. Details of the generator are in
[scripts/loadtest/README.md](../scripts/loadtest/README.md), orchestration is in
[scripts/loadtest/loadtest.sh](../scripts/loadtest/loadtest.sh).

Each configuration runs `--repeat` windows (default 3) back to back; the headline numbers are the median across windows, with min-max ranges in the JSON (`aggregate`) and in the chart table, and every window in `runs`. Outputs go to `results/` (`results/smoke/` for `--smoke`, so published results are never overwritten):

- `loadtest-<date>.json` (1 worker) and `loadtest-<date>-workers<N>.json` (N > 1): raw results, including per-second sent/processed counts.
- `loadtest-<date>[-workers<N>].html`: chart per run.
- `loadtest-<date>-compare.html`: chart comparing the runs.

## What is measured

Each event has a unique sequence number and a send timestamp (`Date.now()` in the load generator, same host clock assumed).

- **e2e**: time from sending the event over ingest HTTP to the generator receiving the alert push (`{type:alert,alertId}`) on the UI push channel `alerting:ui:push`. Send time is taken just before the HTTP batch is written, so it includes HTTP, XADD, parse worker, Postgres insert, engine and pub/sub.
- **notification**: `Notification.createdAt` (enqueue time in the engine) minus send time, read from the UI channel notification push. It measures enqueue, not delivery; it is null when no delivery worker is running.
- **lost**: events accepted (HTTP 202) with no alert observed after the drain and not still queued: `lost = max(0, accepted - alertsSeen - backlogAtEnd)`, where `backlogAtEnd` is lag + pending of the parse and engine consumer groups at the end of the drain. Queued events are reported as `unprocessedAtEnd`/`backlogAtEnd` (late, not lost).
- **overload**: before each window a preflight waits until both groups are idle (lag + pending <= 100). A window that does not drain within 60 s is flagged `overloaded`, later windows are skipped and only completed windows are aggregated. `processedPerSec` is then the sustainable rate (alerts observed per second over send window plus drain), and `targets.met` is false.
- Latency covers events whose alert was observed.

The exact wording is in the `measurement` field of each JSON file.

Every run deletes the Redis dedup keys and Postgres alert and event rows it created (only ids prefixed `lt-tmp-`), so repeated runs do not fill the dev databases; `--keep-data` keeps them, `node scripts/loadtest/run.mjs --cleanup-only` purges leftovers. See the loadtest README.

## Results

### Current code (after #171, commit `7b6424b`)

Local mode, 60 s windows at 5000 ev/s, 3 measurement windows per configuration, 0 rejected, 0 HTTP errors, no overloaded window, `lost` 0 and `backlog.delivery` 0 in every window (the load test counts the delivery backlog, see below). Values are medians across the 3 windows with [min-max] from `aggregate.range` where the JSON provides it. One run per configuration, so the window-to-window spread is the only noise estimate; treat the comparison between 1 and 2 workers as indicative.

| | 1 worker, 5000 ev/s | 2 workers, 5000 ev/s |
| --- | --- | --- |
| Send rate (ev/s) | 4999.1 | 4999.1 |
| Processed/s | 4998.7 [4998-4998.8] | 4999.1 [4998.3-4999.3] |
| Events accepted / alerts seen (3 windows) | 899915 / 899915 | 899910 / 899910 |
| Backlog at end (incl. delivery) | 0 | 0 |
| Lost | 0 | 0 |
| e2e p50 (ms) | 20 [19-23] | 13 [11-17] |
| e2e p90 (ms) | 233 | 55 |
| e2e p99 (ms) | 601 [265-2801] | 316 [141-319] |
| e2e max (ms) | 1064 | 547 |
| notification p50 (ms) | 11 | 7 |
| notification p99 (ms) | 477 | 219 |
| Targets met (p50 < 50, p99 < 250, 0 lost, no backlog) | no | no |

Per window (e2e and notification in ms):

| Config | Window | Processed/s | e2e p50 | e2e p90 | e2e p99 | e2e max | notif p50 | notif p99 | Lost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 worker | 1 | 4998.8 | 19 | 759 | 2801 | 7035 | 11 | 2762 | 0 |
| 1 worker | 2 | 4998 | 23 | 233 | 601 | 1064 | 12 | 477 | 0 |
| 1 worker | 3 | 4998.7 | 20 | 61 | 265 | 467 | 10 | 181 | 0 |
| 2 workers | 1 | 4999.1 | 11 | 21 | 141 | 483 | 6 | 76 | 0 |
| 2 workers | 2 | 4999.3 | 13 | 55 | 316 | 651 | 7 | 223 | 0 |
| 2 workers | 3 | 4998.3 | 17 | 84 | 319 | 547 | 9 | 219 | 0 |

Sources: [1 worker, 5000 ev/s](../results/loadtest-2026-11-21.json) ([chart](../results/loadtest-2026-11-21.html)),
[2 workers, 5000 ev/s](../results/loadtest-2026-11-21-workers2.json) ([chart](../results/loadtest-2026-11-21-workers2.html)),
[comparison chart](../results/loadtest-2026-11-21-compare.html). The 1000 ev/s figures in the history below come from [1 worker, 1000 ev/s](../results/loadtest-2026-11-21-rate1000.json) ([chart](../results/loadtest-2026-11-21-rate1000.html)).

#### Reading the results

- **Nothing overloads and nothing is lost.** `lost` is 0 and the backlog at the end of the drain (parse, engine and delivery) is 0 in all 6 windows. Notification latency is now measured in every window.
- **Targets.** p50 < 50 ms is met in all windows (medians 20 ms and 13 ms). p99 < 250 ms is not met in the medians: 601 ms with 1 worker and 316 ms with 2 workers, so `targets.met` is false for both. Only 2 workers window 1 (141 ms) is under 250 ms, and 1 worker window 3 (265 ms) is close.
- **2 workers are lower than 1 worker** at p50, p90 and p99 in the medians, and their windows vary less (p99 141-319 ms against 265-2801 ms). With one run per configuration this is a single sample, not a statistically established difference. Both keep up with the send rate (about 4999 ev/s processed), so scaling in throughput cannot be shown at this rate.
- **1 worker window 1 looks like warm-up:** its p99 is 2801 ms and max 7035 ms, and the per-second `processed` series of the median window shows stalls (for example 0 processed in second 37) followed by catch-up bursts. The later windows are much better (601, then 265 ms).
- No repeat-keys scenario and no CPU figures are part of these runs.

#### Delivery queue

The delivery worker in the api process (`packages/delivery/src/queue.ts`) runs `DELIVERY_CONCURRENCY` loops (default 4). Each loop moves `DELIVERY_BATCH_SIZE` items (default 50) per round trip: one Lua `RPOPLPUSH` batch from `alerting:delivery:queue` into the worker's processing list, sends in pop order, then one `MULTI` acknowledges the batch. The retry zset is scheduled future work and is not counted as backlog. When a delivery worker is live (a member of `alerting:delivery:processing:workers` with its `:alive` key), the load test counts the delivery queue and processing lists in the preflight idle wait, the drain wait and `backlogAtEnd` (`backlog.delivery`, `backlog.deliveryWorker`); without a live worker the value is recorded but ignored by those gates. This replaces the earlier single-concurrency worker, which fell behind at 5000 ev/s (see the history below).

### History: after #137, before #171 (commit `37330d5`)

The files these numbers came from were replaced by the #171 run above (same names); the old JSON is in git history. Local mode, 60 s windows, 3 measurement windows per configuration, 0 rejected, 0 HTTP errors. Values are medians across the 3 windows with [min-max] from `aggregate.range` where the JSON provided it. The database was `VACUUM ANALYZE`d before the run. The 1000 ev/s column is still the published [rate1000](../results/loadtest-2026-11-21-rate1000.json) file.

| | 1 worker, 1000 ev/s | 1 worker, 5000 ev/s | 2 workers, 5000 ev/s |
| --- | --- | --- | --- |
| Send rate (ev/s) | 999.8 | 4999.2 | 4999.2 |
| Processed/s | 999.6 [999.6-999.6] | 4994.9 [4990.9-4996.1] | 4995.7 [4995.7-4996.2] |
| Events accepted (3 windows) | 179985 | 899935 | 899955 |
| Alerts seen (3 windows) | 179985 | 899935 | 899955 |
| Backlog at end | 0 | 0 | 0 |
| Overloaded | no | no | no |
| Lost | 0 | 0 | 0 |
| e2e p50 (ms) | 24 [24-25] | 67 [50-77] | 56 [54-66] |
| e2e p90 (ms) | 31 | 544 | 113 |
| e2e p99 (ms) | 40 [37-42] | 1342 [402-2335] | 373 [228-952] |
| e2e max (ms) | 68 | 1536 | 596 |
| notification p50 (ms) | 14 | 35 (partial; delivery queue, history) | n/a (partial; delivery queue, history) |
| notification p99 (ms) | 24 | 103 (partial; delivery queue, history) | n/a (partial; delivery queue, history) |
| Targets met (p50 < 50, p99 < 250, 0 lost, no backlog) | yes | no | no |

Notification latency is only available where the generator saw notification pushes for enough events: 119988 samples at 1000 ev/s, 87937 at 5000 ev/s with 1 worker (median window only), none in the 2 worker JSON.

Per window (e2e in ms):

| Config | Window | Processed/s | e2e p50 | e2e p90 | e2e p99 | e2e max | Lost |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 worker, 1000 ev/s | 1 | 999.6 | 25 | 31 | 42 | 70 | 0 |
| 1 worker, 1000 ev/s | 2 | 999.6 | 24 | 31 | 40 | 54 | 0 |
| 1 worker, 1000 ev/s | 3 | 999.6 | 24 | 30 | 37 | 68 | 0 |
| 1 worker, 5000 ev/s | 1 | 4994.9 | 67 | 544 | 1342 | 1536 | 0 |
| 1 worker, 5000 ev/s | 2 | 4996.1 | 50 | 80 | 402 | 630 | 0 |
| 1 worker, 5000 ev/s | 3 | 4990.9 | 77 | 1196 | 2335 | 2670 | 0 |
| 2 workers, 5000 ev/s | 1 | 4995.7 | 54 | 85 | 228 | 425 | 0 |
| 2 workers, 5000 ev/s | 2 | 4995.7 | 56 | 113 | 373 | 596 | 0 |
| 2 workers, 5000 ev/s | 3 | 4996.2 | 66 | 568 | 952 | 1346 | 0 |

#### Reading the results (#137, history)

- **Nothing overloads and nothing is lost.** No window was overloaded, `lost` is 0 and the backlog at the end of the drain is 0 in every window of all three configurations.
- **Both configurations keep up at 5000 ev/s**, so "2 workers sustain more than 1" cannot be shown at this rate: both process about 4995 ev/s, equal to the send rate. A higher send rate would be needed to separate them.
- **2 workers have lower latency at 5000 ev/s:** e2e p50 56 ms against 67 ms, p99 373 ms against 1342 ms (medians). The 1 worker windows vary a lot (p99 402-2335 ms).
- **Targets.** p50 < 50 ms is met at 1000 ev/s (24 ms) but not at 5000 ev/s in these 60 s windows (2 workers 56 ms [54-66], 1 worker 67 ms [50-77]). p99 < 250 ms is met at 1000 ev/s (40 ms) and missed at 5000 ev/s. Shorter 30 s windows measured during development gave p50 of 45-49 ms at 5000 ev/s; those runs are not in the published files.
- **Repeat keys (`--repeat-keys 500`, both 5000 ev/s runs):** 500 identical events with one dedup key produced exactly 1 alert with `count` 500 (`{events: 500, probes: 1, alerts: 1, count: 500, ok: true}`), so the lock-free dedup counts repeats exactly under load. The 1000 ev/s run did not use `--repeat-keys`.
- **Where the time goes.** Per-stage timings measured during development at 2 workers and 5000 ev/s (not part of the published files): api and ingest take about 22-27 ms before the engine sees the event; engine dedup takes about 18-21 ms, of which the Postgres upsert is about 11 ms (commit flush) and the rest about 5 ms.
- All processes (load generator, api, workers, engines, Postgres, Redis) run on one host with 22 cores, so they compete for CPU.

#### Delivery queue caveat (history, fixed by #171)

At the time of these runs notification push stats were missing for some windows because notifications were enqueued but delivered late, not dropped: one delivery worker in the api process with concurrency 1 fell behind at 5000 ev/s (api at 75-106% CPU) and the queue held about 1M entries after the runs. The load test did not include the delivery queue in its preflight or backlog. #171 fixed both, see "Delivery queue" above.

### What changed (#137)

- Batched, concurrent engine runner: `XREADGROUP COUNT 200` with read-ahead, running events concurrently while keeping order per (rule, dedupKey).
- Lock-free dedup: a Redis `SET NX` claim per event, then one multi-row Postgres statement that claims the key in `alert_open_keys` (`INSERT ... ON CONFLICT`) and inserts or bumps the alert (migration `006_alert_open_keys.sql`; no constraint on other writers of `alerts`).
- Redis auto-pipelining, so concurrent commands share round trips.
- One `XACK` per tick instead of one per entry.
- `ENGINE_PG_POOL_MAX` env var for the engine Postgres pool (default 10; mind `max_connections` times the number of engines).

The published numbers were measured on `37330d5` (the partial unique index version). A 30 s confirming run on `36bcd9e` (`alert_open_keys`) gave p50 51 ms, p99 131 ms, 0 lost, not overloaded and repeat-keys ok; it is not in the published files.

### After the dedup merge, before #137 (commit `dd583dd`)

Measured after the engine dedup/throttle from #61 and before #137, local mode, 5000 ev/s target for 60 s, 0 rejected, 0 HTTP errors. Both configurations were **overloaded**: the drain did not finish within the 60 s drain cap, so only 1 of 3 planned windows ran for each and the numbers below are a single window. The raw files were replaced by the current run (the file names are reused); the old JSON is in git history, for example `git show 394e05f:results/loadtest-2026-11-21.json`. Backlog and lost are defined in the [loadtest README](../scripts/loadtest/README.md): `backlogAtEnd` is what is still queued in the streams at the end of the drain (late, not lost), `lost = max(0, unprocessedAtEnd - backlogAtEnd)`, and `processedPerSec` is alerts observed per second over send window plus drain, i.e. the sustainable rate.

| | 1 worker | 2 workers |
| --- | --- | --- |
| Target rate (ev/s) | 5000 | 5000 |
| Send rate (ev/s) | 4999.1 | 4999.2 |
| Processed/s (sustainable rate) | 519.3 | 930.4 |
| Events accepted | 299950 | 299960 |
| Alerts seen | 62596 | 112139 |
| Backlog at end (engine stream) | 237354 | 187821 |
| Overloaded | yes | yes |
| e2e p50 (ms) | 63843 | 66533 |
| e2e p90 (ms) | 98133 | 90050 |
| e2e p99 (ms) | 107226 | 97726 |
| e2e max (ms) | 108004 | 98104 |
| notification p50 (ms) | 63826 | 66514 |
| notification p99 (ms) | 107199 | 97688 |
| Lost | 0 | 0 |
| Targets met (p50 < 50, p99 < 250, 0 lost, no backlog) | no | no |

Reading (past results, single overloaded window each):

- **Throughput scales with workers.** 2 workers sustain 930.4 ev/s against 519.3 ev/s for 1 worker, about 1.8x. Both are far below the 4999 ev/s send rate.
- **Latency here is queueing, not processing.** Because the engine cannot keep up, events wait in the stream: e2e p50 is 63843 ms (1 worker) and 66533 ms (2 workers), p99 107226 ms and 97726 ms. These values are dominated by how long the backlog is when each event is reached and say little about per-event cost. The 2 worker latencies are therefore not lower than the 1 worker ones despite the higher throughput.
- **No event was lost.** `lost` is 0 in both; 237354 (1 worker) and 187821 (2 workers) accepted events were still queued in the engine stream (`backlogAtEnd`) when the drain ended.
- **Targets are not met** (p50 < 50 ms, p99 < 250 ms) in either configuration at 5000 ev/s.

#137 fixed this: the engine had processed stream entries one at a time (`XREADGROUP COUNT 10`, sequential handle) with about 10 Redis and 2 Postgres round trips per alert under a polled dedup lock.

### Before the dedup merge (commit `1c5d7b3`)

These were measured before #61 was merged: 3 windows per configuration, 2 workers sustained 5000 ev/s with p50 9 ms. Raw files: [1 worker](../results/loadtest-2026-11-21-before-dedup.json), [2 workers](../results/loadtest-2026-11-21-before-dedup-workers2.json), [comparison chart](../results/loadtest-2026-11-21-before-dedup-compare.html).

Both configurations: 5000 ev/s target, 60 s per window, 3 measurement windows each, commit `1c5d7b3`, local mode, 0 rejected, 0 HTTP errors. Values are medians across the 3 windows with [min-max] in brackets (from `aggregate.range` where the JSON provides it, otherwise from `runs`).

| | 1 worker | 2 workers |
| --- | --- | --- |
| Target rate (ev/s) | 5000 | 5000 |
| Send rate (ev/s) | 4999.2 | 4999.2 |
| Processed/s | 4932.7 [4715.9-4999.2] | 4999.3 [4999-4999.3] |
| Events sent / alerts seen (3 windows) | 899905 / 899905 | 899915 / 899915 |
| e2e samples (push coverage) | 899905 (100%) | 899915 (100%) |
| e2e p50 (ms) | 946 [14-2420] | 9 [8-9] |
| e2e p90 (ms) | 2334 | 151 |
| e2e p99 (ms) | 3784 [2267-6876] | 531 [379-1089] |
| e2e max (ms) | 3809 | 655 |
| notification p50 (ms) | 945 | 9 |
| notification p90 (ms) | 2333 | 151 |
| notification p99 (ms) | 3783 | 530 |
| notification max (ms) | 3809 | 655 |
| Lost (sum over windows) | 0 | 0 |
| Targets met (p50 < 50, p99 < 250, 0 lost) | no | no |

Per window (e2e in ms):

| Workers | Window | Processed/s | e2e p50 | e2e p90 | e2e p99 | e2e max | Lost |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 4715.9 | 14 | 2334 | 3784 | 3809 | 0 |
| 1 | 2 | 4932.7 | 946 | 2079 | 2267 | 2306 | 0 |
| 1 | 3 | 4999.2 | 2420 | 6225 | 6876 | 6964 | 0 |
| 2 | 1 | 4999 | 9 | 151 | 531 | 655 | 0 |
| 2 | 2 | 4999.3 | 8 | 55 | 379 | 475 | 0 |
| 2 | 3 | 4999.3 | 9 | 358 | 1089 | 1270 | 0 |

Sources: [1 worker](../results/loadtest-2026-11-21-before-dedup.json),
[2 workers](../results/loadtest-2026-11-21-before-dedup-workers2.json),
[comparison chart](../results/loadtest-2026-11-21-before-dedup-compare.html).

#### Reading the results (before)

- **Targets are not met in either configuration** (`targets.met` is false for both). 0 events were lost in both: every accepted event produced an alert.
- **1 worker misses p50 and p99 and falls behind at 5000 ev/s.** Median processed/s is 4932.7 (window range 4715.9-4999.2) against a send rate of 4999.2, so a backlog builds. Median p50 is 946 ms (target 50 ms) and median p99 is 3784 ms (target 250 ms). The spread between windows is very large (p50 14-2420 ms, p99 2267-6876 ms), so the median is only a rough guide.
- **2 workers sustain 5000 ev/s, meet p50, miss p99.** Processed/s is 4999.3 [4999-4999.3], matching the send rate. Median p50 is 9 ms [8-9] (target 50 ms, met in all 3 windows). Median p99 is 531 ms [379-1089] against the 250 ms target, missed in all 3 windows. The per-second `processed` series in the JSON shows stalls followed by catch-up spikes.
- Notification latency (enqueue time) tracks e2e within 1 ms at every percentile in the medians.

## Caveats

- These numbers were measured in **local mode** (`just loadtest --local`): processes on the dev container host with local Postgres and Redis, not inside docker compose (docker was not available). The hardware is not characterised, and the load generator, stack, Postgres and Redis share it.
- The api process also runs an in-process ingest parse worker. "N workers" therefore means N engines and N+1 parse consumers (N standalone parse workers plus the api's own). This is also recorded in `config.note` of each result JSON.
- The load-test rule matches on a run id field of the parsed event, because schema classification is not applied in ingest yet. Real rules with schema lookups would cost more.
- The current results are 3 windows per configuration, one run per configuration, none overloaded; 1 worker at 5000 ev/s varies a lot between windows (p99 265-2801 ms). The dd583dd results were a single overloaded window each, the before-dedup results 3 windows each with large variation.
- The compose run (`just loadtest` without `--local`) has not produced published numbers yet.

## Re-running and updating

1. Run `just loadtest` (or `just loadtest --local` without docker). It writes new files named with today's date under `results/`.
2. Compare runs with `node scripts/loadtest/chart.mjs --out results/loadtest-<date>-compare.html a.json b.json`.
3. Update the table and reading above from the new JSON files (copy the values, do not round), and the headline numbers in the Performance section of the [README](../README.md).
