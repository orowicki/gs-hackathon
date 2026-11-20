---
description: Install the autopilot kit (container, settings, state templates, justfile recipes) into this repo.
argument-hint: "[core|research|hackathon]"
---
Run `autopilot-init . --profile ${ARGUMENTS:-core}` (it is on PATH from this plugin's bin/). Show its output. It never overwrites files; if it reports a settings.json conflict, show the human the differences and let them merge it. Then walk the human through filling docs/autopilot/SPEC.md. Don't set `ready: true` yourself.
