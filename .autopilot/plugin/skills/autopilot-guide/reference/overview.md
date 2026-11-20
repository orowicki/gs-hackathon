# Overview

The autopilot builds software from a written spec while you're away. You write **what** you want (SPEC.md); it plans, writes code and tests through cheaper sub-agents, checks its own work, opens pull requests for you to review, and stops with a clear status when it needs you, runs out of budget or is done. You review and merge; the AI never merges. (Exception: with the hackathon profile in team mode, the supervisor auto-merges PRs the AI marked `Review: not needed` after a few minutes unless someone comments; see github.md.)

## The loop
```
you: write SPEC.md (goal, acceptance criteria), set ready: true
  -> ap autopilot (in the container)
       supervisor starts Claude for one "run"
         coordinator (Opus) plans milestones -> implementer agents write code + tests
         -> reviewer + verifier agents check it -> commit, push, draft PR -> ready PR
       stops with a status, or continues with a fresh run
  -> you: answer questions (ap decide or on GitHub), review and merge PRs
  -> ap autopilot again (or leave it running with --wait in team mode)
```

## Parts
- **Supervisor** (`scripts/autopilot/supervisor.py`): plain Python, no AI. Starts Claude, watches it (watchdog for hangs), records spend, enforces the budget, restarts it, sends notifications, and in team mode talks to GitHub (claims, decision sync, heartbeats).
- **Coordinator** (the `autopilot` skill, Opus): plans and delegates; doesn't write production code itself.
- **Agents**: `implementer` (code + tests), `reviewer` (diff review), `verifier` (runs the checks against the SPEC criteria), `scout` (cheap lookups). The research profile adds its own.
- **Hooks**: `guard` (blocks unsafe commands and edits), `stop_gate` (won't let a run end with agents still running or failing checks), `session_start` (feeds the current state into each run).
- **Container**: a devcontainer with a firewall that only allows the services the build needs.

## Files in a project
| Where | What | Who writes it |
|---|---|---|
| `docs/autopilot/SPEC.md` | goal, acceptance criteria, `ready`, `profile`, `budget_usd` | you |
| `docs/autopilot/NOTES-HUMAN.md` | hints and corrections for the autopilot | you |
| `docs/autopilot/STATE.md` | current status (line 1) | autopilot |
| `docs/autopilot/PLAN.md`, `JOURNAL.md`, `DECISIONS.md`, `REPORT.md` | plan, history with evidence, questions for you, final report | autopilot (you answer in DECISIONS) |
| `autopilot.toml` | settings | you |
| `.autopilot/plugin/` | the kit's own copy (updated by `ap init`) | the kit |
| `results/autopilot/` | run logs and the spend ledger (not in git) | supervisor |

In **team mode** the autopilot's STATE, PLAN, JOURNAL, DECISIONS live in its own worktree (`.autopilot/work/results/autopilot/team/<login>/`), not in git; GitHub issues and PRs are the shared record. See `team-mode.md`.

## Profiles
Set in the SPEC frontmatter (`profile:`):
- **core**: careful default. Milestones, review and verification for each.
- **hackathon**: a working demo fast. Walking skeleton first, demo kept runnable, takes recommended defaults instead of waiting (journals them), up to 4 parallel implementers, claims expire after 2 h in team mode.
- **research**: experiments done properly. Pre-registered metric and decision rule, 3+ runs, averaged judges, eval set used once, revert if not better.

## What it won't do
Merge, approve or close PRs; push to main; tag; change git config or your identity; read secrets; edit SPEC, NOTES-HUMAN or the kit's settings; reach websites outside the allowlist. See `safety.md`.
