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

Load test at 5000 ev/s for 60 s (local mode, one run each): 1 worker falls behind (processed 4664.5/s, e2e p50 882 ms, p99 3560 ms, 0 lost); 2 workers sustain the rate (processed 4999.3/s, e2e p50 10 ms, p99 5193 ms, 0 lost). The p50 target (< 50 ms) is met with 2 workers, the p99 target (< 250 ms) is not in either run.
Details, caveats and how to re-run (`just loadtest`): [docs/performance.md](docs/performance.md). Raw results: [1 worker](results/loadtest-2026-11-21.json), [2 workers](results/loadtest-2026-11-21-workers2.json).
