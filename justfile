default:
    @just --list

# Lint (eslint + type-check)
lint:
    npm run lint

# Tests (unit + web smoke test with screenshots)
test:
    npm test
    npm run test:e2e -w @alerting/web

# Auto-format / autofix
fmt:
    npx eslint . --fix

# Build and start the stack, wait up to 120 s for /health
up:
    #!/usr/bin/env bash
    set -u
    docker compose up -d --build || exit 1
    for i in $(seq 1 60); do
      if out=$(curl -fsS http://localhost:3000/health 2>/dev/null); then echo "healthy: $out"; break; fi
      sleep 2
    done
    if [ -z "${out:-}" ]; then
      echo "not healthy after 120 s" >&2
      docker compose ps >&2
      exit 1
    fi
    # Seed demo data (only creates what is missing; safe to run on every `just up`).
    if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=6)?0:1)'; then
      echo "Node 22.6+ is required on the host for seeding (found $(node -v)); the stack is up, rerun 'just up' after upgrading" >&2
      exit 1
    fi
    [ -d node_modules/yaml ] || npm ci --no-audit --no-fund || exit 1
    node --experimental-strip-types --no-warnings scripts/seed/seed.ts || { echo "seeding failed" >&2; exit 1; }
    echo "ready: http://localhost:3000 (run 'just demo' for sample traffic)"

# Send demo events through all three sources, e.g. `just demo --once` or `just demo --rate 5 --duration 30`
demo *args:
    node --experimental-strip-types --no-warnings scripts/demo/demo.ts {{args}}

# 15-minute mixed run: known events, and from 10 s on also events of a schema nothing recognises
# (eventName = md.feed.stale), e.g. to add that schema live. Flags as for `just demo`; yours win, e.g. `just longtest --rate 5`
longtest *args:
    node --experimental-strip-types --no-warnings scripts/demo/demo.ts {{args}} --duration 900 --unknown-after 10

# Run the MCP server on stdio (builds first; API base URL from ALERTING_API_URL, default http://localhost:3000)
mcp:
    @npm run build -w @alerting/mcp >&2
    @node packages/mcp/dist/main.js

# Stop the stack
down:
    docker compose down

# --- autopilot kit (added by autopilot-init) ---------------------------------
_ap_py := "uv run -q --no-project --with rich==13.9.4 env PYTHONPATH=.autopilot/plugin/template/scripts python"

# Run the autopilot until DONE / WAITING / BLOCKED / BUDGET (relaunches itself)
# (exit 3 = Blocked, 4 = Budget used up: planned stops the summary explains, not errors)
autopilot *args:
    @{{_ap_py}} -m autopilot.supervisor {{args}} || { rc=$?; [ $rc -eq 3 ] || [ $rc -eq 4 ] || exit $rc; }

# Answer open decisions (letter / Enter = recommended / text), then offer to resume
decide *args:
    {{_ap_py}} -m autopilot.decide {{args}}

# Team mode: `just team init` (labels), `just team status` (who holds what)
team *args:
    @{{_ap_py}} -m autopilot.team {{args}}

# Interactive Claude with the kit's plugin loaded (/autopilot:decide, /autopilot:status)
chat *args:
    if [ "${AUTOPILOT_CONTAINER:-}" = 1 ] || [ -e /.dockerenv ] || [ -e /run/.containerenv ]; then claude --plugin-dir .autopilot/plugin --settings '{"sandbox":{"enabled":false}}' {{args}}; else claude --plugin-dir .autopilot/plugin {{args}}; fi

# Check the environment before spending anything
doctor *args:
    {{_ap_py}} -m autopilot.doctor {{args}}

# Replay a run log in the live view
replay log:
    {{_ap_py}} -m autopilot.view {{log}}

# Spend so far (from the ledger)
spend:
    {{_ap_py}} -m autopilot.ledger

# Load test: 1 then 2 workers (docker). Flags: --workers N --smoke --local --rate R --duration S
loadtest *args:
    bash scripts/loadtest/loadtest.sh {{args}}

# Regenerate docs/api.md from the OpenAPI document (needs a build of @alerting/api)
docs-api:
    npm run build -w @alerting/api
    node --experimental-strip-types --no-warnings scripts/docs/api-reference.ts
