# Load test

`node scripts/loadtest/run.mjs --rate 5000 --duration 60 [--workers n] [--base-url] [--redis] [--database-url] [--out file.json] [--smoke] [--no-chart]`

Needs the app (API with in-process ingest), a parse worker, the engine, Redis and Postgres running. It upserts a
temporary source `loadtest`, rule `loadtest-rule` (matching `run = "<runId>"` on the parsed event) and person
`loadtest-bot` (channel ui only) directly into the config store (`--database-url`, default `$DATABASE_URL`; change events
go over `--redis`), waits until probes produce an alert, sends events, drains, writes
`results/loadtest-<date>[-workers<n>].json` plus an `.html` chart, and deletes the entries again. `--config-dir` is
accepted and ignored.

`node scripts/loadtest/chart.mjs --out compare.html a.json b.json` compares runs. The `measurement` field in each
JSON says exactly what is measured. Note: rules see `event.parsed` as raw fields, so the rule matches on `run`,
not on `alert.source` (which needs `common.source`).
