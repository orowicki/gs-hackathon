# Load test

`node scripts/loadtest/run.mjs --rate 5000 --duration 60 [--workers n] [--base-url] [--redis] [--database-url] [--out file.json] [--repeat N] [--smoke] [--no-chart]`

`--repeat N` (default 3, smoke default 1) runs N measurement windows back to back on the same stack, each fully drained before the next. The top-level JSON fields are the median across windows (counts are sums), `aggregate` holds the method and min-max ranges, and `runs` holds the full per-window results. `targets.met` uses the medians, zero lost events and full push coverage. Before every window a preflight waits (progress logged every 10 s, `--preflight-timeout` seconds, default 600, then abort) until the parse group on `alerting:events:raw` and the engine group on `alerting:events` each have lag + pending <= 100; streams are never trimmed or deleted. If a window does not fully drain within the drain cap (60 s) it is marked `overloaded`, the remaining windows are skipped and only completed windows are aggregated (`windowsCompleted`). At the end of the drain the backlog of both groups is recorded as `backlogAtEnd`; `unprocessedAtEnd` = accepted - alertsSeen and `lost = max(0, unprocessedAtEnd - backlogAtEnd)`, so queued events count as late, not lost. `processedPerSec` is alerts observed per second over send window plus drain. `targets.met` also needs `backlogAtEnd == 0` and no overload. **Data cleanup:** the engine and ingest leave state keyed by the temporary ids. After the config entries are removed (and at startup, for leftovers of crashed runs) `cleanup.mjs` deletes only that state: Redis keys `alerting:dedup:lt-tmp-*`, `dedupseen`, `deduplock`, `throttle`, `digest` (SCAN + UNLINK in batches of 1000) and Postgres rows in `alert_audit`, `suggestions`, `alerts` (rule id `lt-tmp-%`) and `events` (source id `lt-tmp-%`), with the counts logged. Redis stream entries are not touched and remain (capped only by the producers' MAXLEN, if any). `--keep-data` skips this; `--cleanup-only` runs just the stale purge (config entries and data) and exits.

`--smoke` (5 s at 200 ev/s) writes to `results/smoke/` by default so published results are not overwritten.

Note: the api process runs an in-process ingest parse worker, so N workers means N engines and N+1 parse consumers (also recorded in `config.note` of the JSON).

Needs the app (API with in-process ingest), a parse worker, the engine, Redis and Postgres running. It upserts a
temporary source `lt-tmp-<runId>`, rule (matching `run matches "<runId>*"` on the parsed event) and person
`lt-tmp-bot-<runId>` (channel ui only) directly into the config store (`--database-url`, default `$DATABASE_URL`; change events
go over `--redis`), waits until probes produce an alert, sends events, drains, writes
`results/loadtest-<date>[-workers<n>].json` (`results/smoke/...` with `--smoke`) plus an `.html` chart, and deletes the entries again. `--config-dir` is
accepted and ignored.

`node scripts/loadtest/chart.mjs --out compare.html a.json b.json` compares runs. The `measurement` field in each
JSON says exactly what is measured. Note: rules see `event.parsed` as raw fields, so the rule matches on `run`,
not on `alert.source` (which needs `common.source`).
