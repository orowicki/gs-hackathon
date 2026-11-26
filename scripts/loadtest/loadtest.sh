#!/usr/bin/env bash
# Load test orchestration: runs scripts/loadtest/run.mjs with 1 then 2 workers.
# Usage: loadtest.sh [--workers N] [--smoke] [--local] [--rate R] [--duration S] [--repeat N] [--repeat-keys N]
# --smoke writes to results/smoke/ so published results are never overwritten.
set -euo pipefail
cd "$(dirname "$0")/../.."

workers=""; local_mode=0; smoke=0; passthru=()
while [ $# -gt 0 ]; do
  case "$1" in
    --workers) workers="$2"; shift 2 ;;
    --local) local_mode=1; shift ;;
    --smoke) passthru+=(--smoke); smoke=1; shift ;;
    --rate|--duration|--repeat|--repeat-keys) passthru+=("$1" "$2"); shift 2 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done
runs=(1 2); [ -n "$workers" ] && runs=("$workers")

date=$(date +%F); outdir=results; [ "$smoke" = 1 ] && outdir=results/smoke; mkdir -p "$outdir"
port=${LOADTEST_PORT:-3000}
stack_pid=""
cleanup() {
  if [ -n "$stack_pid" ] && kill -0 "$stack_pid" 2>/dev/null; then
    kill "$stack_pid" 2>/dev/null || true; wait "$stack_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT

wait_health() {
  for _ in $(seq 1 60); do
    curl -fsS "http://localhost:$port/health" >/dev/null 2>&1 && return 0
    sleep 2
  done
  echo "stack not healthy after 120 s" >&2; return 1
}

outs=()
for n in "${runs[@]}"; do
  out="$outdir/loadtest-$date.json"; [ "$n" != 1 ] && out="$outdir/loadtest-$date-workers$n.json"
  echo "== load test with $n worker(s) ==" >&2
  if [ "$local_mode" = 1 ]; then
    if curl -fsS "http://localhost:$port/health" >/dev/null 2>&1; then
      echo "port $port already answers /health: stop that process or set LOADTEST_PORT" >&2
      exit 1
    fi
    for p in packages/api packages/ingest packages/engine; do
      [ -f "$p/dist/main.js" ] || { npm run build; break; }
    done
    ready=$(mktemp -p "$PWD/$outdir" .ready.XXXXXX)
    node scripts/loadtest/local-stack.mjs --workers "$n" >"$ready" &
    stack_pid=$!
    for _ in $(seq 1 130); do
      grep -q '^ready$' "$ready" && break
      kill -0 "$stack_pid" 2>/dev/null || { echo "local stack died" >&2; rm -f "$ready"; exit 1; }
      sleep 1
    done
    rm -f "$ready"
    BASE_URL="http://localhost:$port" node scripts/loadtest/run.mjs ${passthru[@]+"${passthru[@]}"} \
      --workers "$n" --base-url "http://localhost:$port" \
      --redis "${REDIS_URL:-redis://localhost:6379}" --database-url "${DATABASE_URL:-postgres://alerting:alerting@localhost:5432/alerting}" --out "$out"
    cleanup; stack_pid=""
  else
    if ! docker compose up -d --build --wait --scale "worker=$n"; then
      echo "docker compose up --wait failed; container state:" >&2
      docker compose ps >&2 || true
      exit 1
    fi
    running=$(docker compose ps --status running -q worker | wc -l | tr -d ' ')
    if [ "$running" != "$n" ]; then
      echo "expected $n running worker containers, found $running" >&2
      docker compose ps >&2 || true
      exit 1
    fi
    docker compose --profile loadtest run --rm loadtest node scripts/loadtest/run.mjs \
      ${passthru[@]+"${passthru[@]}"} --workers "$n" --base-url http://app:3000 \
      --redis redis://redis:6379 --database-url postgres://alerting:alerting@postgres:5432/alerting --out "$out"
    running=$(docker compose ps --status running -q worker | wc -l | tr -d ' ')
    if [ "$running" != "$n" ]; then
      echo "worker containers changed during the run: expected $n, found $running (result invalid)" >&2
      docker compose ps >&2 || true
      exit 1
    fi
  fi
  outs+=("$out")
done

files=("${outs[@]}")
if [ -f "$outdir/loadtest-$date.json" ] && [ -f "$outdir/loadtest-$date-workers2.json" ]; then
  cmp="$outdir/loadtest-$date-compare.html"
  node scripts/loadtest/chart.mjs --out "$cmp" "$outdir/loadtest-$date.json" "$outdir/loadtest-$date-workers2.json"
  files+=("$cmp")
fi
[ "$local_mode" = 1 ] || echo "The compose stack is still running; stop it with: just down" >&2
echo "Outputs:"; printf '  %s\n' "${files[@]}"
