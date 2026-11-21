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
