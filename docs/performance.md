# Performance

Load test results for the ingest to alert path against the SPEC targets: p50 < 50 ms, p99 < 250 ms, 0 lost events.

## Running the test

```sh
just loadtest                  # compose stack: 1 worker, then 2 workers (5000 ev/s for 60 s each)
just loadtest --local          # no docker: processes on the host, local Postgres and Redis
just loadtest --smoke          # short check: 5 s at 200 ev/s
just loadtest --workers N      # a single run with N workers instead of 1 then 2
just loadtest --rate R --duration S
```

Flags combine (for example `just loadtest --local --workers 2`). Details of the generator are in
[scripts/loadtest/README.md](../scripts/loadtest/README.md), orchestration is in
[scripts/loadtest/loadtest.sh](../scripts/loadtest/loadtest.sh).

Outputs go to `results/`:

- `loadtest-<date>.json` (1 worker) and `loadtest-<date>-workers<N>.json` (N > 1): raw results, including per-second sent/processed counts.
- `loadtest-<date>[-workers<N>].html`: chart per run.
- `loadtest-<date>-compare.html`: chart comparing the runs.

## What is measured

Each event has a unique sequence number and a send timestamp (`Date.now()` in the load generator, same host clock assumed).

- **e2e**: time from sending the event over ingest HTTP to the generator receiving the alert push (`{type:alert,alertId}`) on the UI push channel `alerting:ui:push`. Send time is taken just before the HTTP batch is written, so it includes HTTP, XADD, parse worker, Postgres insert, engine and pub/sub.
- **notification**: `Notification.createdAt` (enqueue time in the engine) minus send time, read from the UI channel notification push. It measures enqueue, not delivery.
- **lost**: events accepted (HTTP 202) for which no alert was observed after the drain.
- Latency covers events whose alert was observed.

The exact wording is in the `measurement` field of each JSON file.

## Results

Both runs: 5000 ev/s target, 60 s, commit `9b60a09`, 0 rejected, 0 HTTP errors, single run each (not averaged).

| | 1 worker | 2 workers |
| --- | --- | --- |
| Target rate (ev/s) | 5000 | 5000 |
| Send rate (ev/s) | 4999.1 | 4999.2 |
| Processed/s | 4934.7 | 4999.2 |
| Events sent / alerts seen | 299980 / 299980 | 299955 / 299955 |
| e2e p50 (ms) | 576 | 9 |
| e2e p90 (ms) | 1044 | 254 |
| e2e p99 (ms) | 1250 | 796 |
| e2e max (ms) | 1278 | 1000 |
| notification p50 (ms) | 576 | 9 |
| notification p90 (ms) | 1043 | 254 |
| notification p99 (ms) | 1249 | 796 |
| notification max (ms) | 1278 | 999 |
| Lost | 0 | 0 |
| Targets met (p50 < 50, p99 < 250, 0 lost) | no | no |

Sources: [1 worker](../results/loadtest-2026-11-21.json) ([chart](../results/loadtest-2026-11-21.html)),
[2 workers](../results/loadtest-2026-11-21-workers2.json) ([chart](../results/loadtest-2026-11-21-workers2.html)),
[comparison chart](../results/loadtest-2026-11-21-compare.html).

### Reading the results

- **1 worker falls behind at 5000 ev/s.** Processed/s (4934.7) stays below the send rate (4999.1) and a backlog builds, so latency is high (p50 576 ms, p99 1250 ms). No event was lost: every accepted event produced an alert.
- **2 workers sustain the rate.** Processed/s matches the send rate (4999.2). The p50 target is met (9 ms < 50 ms). The p99 target is missed (796 ms vs 250 ms); p90 is already 254 ms, so a tail of events waits behind bursts. The per-second `processed` series in the JSON shows stalls and catch-up spikes.
- Overall the SPEC latency targets are **not** fully met at 5000 ev/s on this setup: p50 yes (2 workers), p99 no, 0 lost yes.

## Caveats

- These numbers were measured in **local mode** (`just loadtest --local`): processes on the dev container host with local Postgres and Redis, not inside docker compose (docker was not available). The hardware is not characterised, and the load generator, stack, Postgres and Redis share it.
- The api process also runs an in-process ingest parse worker. "N workers" therefore means N x (parse worker + engine) plus the api's own parse worker.
- The load-test rule matches on a run id field of the parsed event, because schema classification is not applied in ingest yet. Real rules with schema lookups would cost more.
- One run per configuration, not averaged. Run-to-run variation is not known; treat p99 in particular as indicative.
- The compose run (`just loadtest` without `--local`) has not produced published numbers yet.

## Re-running and updating

1. Run `just loadtest` (or `just loadtest --local` without docker). It writes new files named with today's date under `results/`.
2. Compare runs with `node scripts/loadtest/chart.mjs --out results/loadtest-<date>-compare.html a.json b.json`.
3. Update the table and reading above from the new JSON files (copy the values, do not round), and the headline numbers in the Performance section of the [README](../README.md).
