# Alerting service

TypeScript monorepo: `packages/api` (HTTP API with `/health`) and `packages/shared`, run with Postgres, Redis and ntfy via Docker Compose.

## Requirements

- Node 20+
- Docker (with Compose)
- [just](https://github.com/casey/just)

## Quick start

```sh
npm install              # needed for just lint / just test
just up                  # build and start the stack, waits for /health
curl localhost:3000/health
just lint
just test
just down
```

## Configuration

All variables have defaults, so the stack runs without any configuration. Override them with a `.env` file in the repo root (gitignored); compose reads it automatically.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Port the API listens on (api defaults to 3000 outside compose) |
| `DATABASE_URL` | `postgres://alerting:alerting@postgres:5432/alerting` | Postgres connection string |
| `REDIS_URL` | `redis://redis:6379` | Redis connection string |
| `NTFY_URL` | `http://ntfy:80` | Base URL of the ntfy server (host access: `http://localhost:8080`) |
| `POSTGRES_USER` | `alerting` | Postgres user created on first start |
| `POSTGRES_PASSWORD` | `alerting` | Postgres password |
| `POSTGRES_DB` | `alerting` | Postgres database name |

## Performance

Load test at 5000 ev/s for 60 s (local mode, current code): both configurations are overloaded. Sustainable throughput is 519.3 ev/s with 1 worker and 930.4 ev/s with 2 workers (about 1.8x); backlog at end 237354 and 187821 events, 0 lost. Latency is dominated by queueing (e2e p50 63843 ms and 66533 ms), so the targets (p50 < 50 ms, p99 < 250 ms) are not met.
Before the engine dedup merge (#61) 2 workers sustained 5000 ev/s with p50 9 ms and p99 531 ms (medians of 3 windows); the regression is in the engine, outside #31.
Details, caveats and how to re-run (`just loadtest`): [docs/performance.md](docs/performance.md). Raw results: [1 worker](results/loadtest-2026-11-21.json), [2 workers](results/loadtest-2026-11-21-workers2.json).
