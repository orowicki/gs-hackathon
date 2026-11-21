#!/usr/bin/env bash
# Load test orchestration: runs scripts/loadtest/run.mjs with 1 then 2 workers.
# Usage: loadtest.sh [--workers N] [--smoke] [--local] [--rate R] [--duration S]
set -euo pipefail
cd "$(dirname "$0")/../.."

workers=""; local_mode=0; passthru=()
while [ $# -gt 0 ]; do
  case "$1" in
    --workers) workers="$2"; shift 2 ;;
    --local) local_mode=1; shift ;;
    --smoke) passthru+=(--smoke); shift ;;
    --rate|--duration) passthru+=("$1" "$2"); shift 2 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done
runs=(1 2); [ -n "$workers" ] && runs=("$workers")

date=$(date +%F); mkdir -p results
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
  out="results/loadtest-$date.json"; [ "$n" != 1 ] && out="results/loadtest-$date-workers$n.json"
  echo "== load test with $n worker(s) ==" >&2
  if [ "$local_mode" = 1 ]; then
    for p in packages/api packages/ingest packages/engine; do
      [ -f "$p/dist/main.js" ] || { npm run build; break; }
    done
    ready=$(mktemp -p "$PWD/results" .ready.XXXXXX)
    node scripts/loadtest/local-stack.mjs --workers "$n" >"$ready" &
    stack_pid=$!
    for _ in $(seq 1 130); do
      grep -q '^ready$' "$ready" && break
      kill -0 "$stack_pid" 2>/dev/null || { echo "local stack died" >&2; rm -f "$ready"; exit 1; }
      sleep 1
    done
    rm -f "$ready"
    BASE_URL="http://localhost:$port" node scripts/loadtest/run.mjs "${passthru[@]}" \
      --workers "$n" --base-url "http://localhost:$port" \
      --redis "${REDIS_URL:-redis://localhost:6379}" --database-url "${DATABASE_URL:-postgres://alerting:alerting@localhost:5432/alerting}" --out "$out"
    cleanup; stack_pid=""
  else
    if ! docker compose up -d --build --wait --scale "worker=$n"; then
      docker compose up -d --build --scale "worker=$n"; wait_health
    fi
    docker compose --profile loadtest run --rm loadtest node scripts/loadtest/run.mjs \
      "${passthru[@]}" --workers "$n" --base-url http://app:3000 \
      --redis redis://redis:6379 --database-url postgres://alerting:alerting@postgres:5432/alerting --out "$out"
  fi
  outs+=("$out")
done

files=("${outs[@]}")
if [ -f "results/loadtest-$date.json" ] && [ -f "results/loadtest-$date-workers2.json" ]; then
  cmp="results/loadtest-$date-compare.html"
  node scripts/loadtest/chart.mjs --out "$cmp" "results/loadtest-$date.json" "results/loadtest-$date-workers2.json"
  files+=("$cmp")
fi
echo "Outputs:"; printf '  %s\n' "${files[@]}"
