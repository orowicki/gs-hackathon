#!/usr/bin/env bash
# Runs the Playwright smoke test. Skips loudly (exit 0) when chromium is unavailable,
# unless CI or E2E_REQUIRED=1 is set.
cd "$(dirname "$0")/.." || exit 1

have_chromium() {
  node -e "const fs=require('fs');const p=require('playwright-core').chromium.executablePath();process.exit(fs.existsSync(p)?0:1)" 2>/dev/null
}

if ! have_chromium; then
  timeout 60 npx playwright install chromium || true
fi

if have_chromium; then
  exec npx playwright test "$@"
fi

msg="SKIPPED web smoke test: Playwright chromium not installed (run: npx playwright install --with-deps chromium)"
if [ -n "${CI:-}" ] || [ "${E2E_REQUIRED:-}" = 1 ]; then
  echo "$msg" >&2
  exit 1
fi
echo "$msg"
exit 0
