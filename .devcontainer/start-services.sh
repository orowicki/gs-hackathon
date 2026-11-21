#!/usr/bin/env bash
# Start a local Postgres and Redis inside the devcontainer so integration tests
# (which need DATABASE_URL / REDIS_URL) run here as they do in CI. Idempotent.
set -euo pipefail

PGBIN=$(ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1)
PGDATA=/home/node/pgdata
PGLOG=/home/node/pgdata.log

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  "$PGBIN/initdb" -D "$PGDATA" -U alerting --auth=trust >/dev/null
fi
if ! "$PGBIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; then
  "$PGBIN/pg_ctl" -D "$PGDATA" -l "$PGLOG" -w \
    -o "-c listen_addresses=localhost -k /tmp" start >/dev/null
fi
if ! psql -h localhost -U alerting -d postgres -tAc "select 1 from pg_database where datname='alerting'" | grep -q 1; then
  createdb -h localhost -U alerting alerting
fi

if ! redis-cli -h 127.0.0.1 ping >/dev/null 2>&1; then
  redis-server --daemonize yes --bind 127.0.0.1 --save "" --appendonly no >/dev/null
  for _ in $(seq 20); do redis-cli -h 127.0.0.1 ping >/dev/null 2>&1 && break; sleep 0.2; done
fi
echo "services up: postgres (localhost:5432/alerting), redis (localhost:6379)"
