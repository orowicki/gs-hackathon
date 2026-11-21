# Load test

`node scripts/loadtest/run.mjs --rate 5000 --duration 60 [--workers n] [--base-url] [--redis] [--database-url] [--out file.json] [--repeat N] [--smoke] [--no-chart]`

`--repeat N` (default 3, smoke default 1) runs N measurement windows back to back on the same stack, each fully drained before the next. The top-level JSON fields are the median across windows (counts are sums), `aggregate` holds the method and min-max ranges, and `runs` holds the full per-window results. `targets.met` uses the medians, zero lost events and full push coverage. `--smoke` (5 s at 200 ev/s) writes to `results/smoke/` by default so published results are not overwritten.

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
