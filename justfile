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
      if out=$(curl -fsS http://localhost:3000/health 2>/dev/null); then echo "healthy: $out"; exit 0; fi
      sleep 2
    done
    echo "not healthy after 120 s" >&2
    docker compose ps >&2
    exit 1

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
