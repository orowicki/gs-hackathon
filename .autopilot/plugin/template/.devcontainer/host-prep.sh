#!/usr/bin/env bash
# Runs on the HOST before the container starts (devcontainer initializeCommand).
# - Creates the secrets env-file OUTSIDE the repo if missing (v1: keys arrived empty).
# - Passes the host timezone and git identity into the container (v1: UTC, agent identity).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
name="$(basename "$(dirname "$here")")"
envdir="$HOME/.config/autopilot"
envfile="$envdir/$name.env"
mkdir -p "$envdir"
if [[ ! -f "$envfile" ]]; then
  umask 077
  printf '# Secrets for %s (never commit). KEY=value, one per line.\n# ANTHROPIC_API_KEY=\n# AUTOPILOT_NTFY_URL=https://ntfy.sh/<long-random-topic>\n' "$name" > "$envfile"
  echo "Created $envfile; add your keys there."
fi
tz="${TZ:-}"
if [[ -z "$tz" && -L /etc/localtime ]]; then tz="$(readlink /etc/localtime | sed -E 's#.*/zoneinfo/##')"; fi
{
  echo "TZ=${tz:-Etc/UTC}"
  n="$(git config --get user.name || true)"; e="$(git config --get user.email || true)"
  [[ -n "$n" ]] && printf 'GIT_AUTHOR_NAME=%s\nGIT_COMMITTER_NAME=%s\n' "$n" "$n"
  [[ -n "$e" ]] && printf 'GIT_AUTHOR_EMAIL=%s\nGIT_COMMITTER_EMAIL=%s\n' "$e" "$e"
} > "$here/.host.env"
