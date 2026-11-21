# Alerting service

TypeScript monorepo: `packages/api` (HTTP API with `/health`) and `packages/shared`, run with Postgres, Redis and ntfy via Docker Compose.

## Requirements

- Node 20+
- Docker (with Compose)
- [just](https://github.com/casey/just)

## Quick start

```sh
cp .env.example .env     # optional, defaults work without it
npm install              # needed for just lint / just test
just up                  # build and start the stack, waits for /health
curl localhost:3000/health
just lint
just test
just down
```
