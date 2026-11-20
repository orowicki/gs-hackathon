# Hackathon runbook (team mode)

Several people, each with their own autopilot, building one project in a few hours. Everything below is the `hackathon` profile with team mode on.

## The night before (one person, ~20 min)
1. Make the GitHub repo, clone it, `ap init --profile hackathon` (host). This adds the container, `autopilot.toml`, the SPEC template, the **Autopilot task** issue form and the **checks** workflow (`.github/workflows/autopilot-checks.yml`: `just lint` and `just test` on every PR; adjust its setup steps to your stack).
2. Write `docs/autopilot/SPEC.md`: goal, numbered acceptance criteria, constraints (stack, "no UI framework", paid APIs), out of scope, and `## Milestones` (`M1 skeleton: …`, one per line). Set `ready: true`, `profile: hackathon`, `budget_usd` (per person).
3. In `autopilot.toml`: `[team] enabled = true`. Then `ap team init` (labels).
4. On GitHub: **Settings → General → Features → Discussions** on, then add a Discussions category named **Autopilot** (team notes).
5. Commit and push. `ap autopilot --dry-run` checks the setup without spending.

## Each teammate (~15 min, before the start)
1. Clone, then `ap setup` (host): GitHub token (Contents, Pull requests, Issues and Discussions: read and write; Actions and Commit statuses: read, so auto-merge can see CI results), ntfy topic for the phone, Claude login, container build.
2. `ap doctor`: everything PASS (WARN on team notes is fine if Discussions aren't set up).
3. Subscribe to your ntfy topic in the phone app.

## Kick-off
1. Everyone: `ap autopilot --wait` (container; keep the terminal open).
2. One autopilot gets the proposing turn and files up to 5 `ap:proposed` issues, interface contract first. The others wait for free. You get **Proposed · <project>**.
3. They become tasks by themselves after 10 minutes (hackathon auto-promote). To stop one: comment on it, or thumbs-down it, or close it. To speed up: promote it yourself (label `ap:task`).
4. Autopilots claim tasks within a few minutes.

## During
| You get | You do |
|---|---|
| **Question** | answer `answer: B` on the issue, or thumbs-up for the default. A teammate can unblock you: `delegate answer: …` |
| **Merging** (PR #9 merges in 5 min) | nothing, or comment on the PR to stop it and review it yourself |
| **Review** | it needs a person (taste, risk, protected files): merge, or `changes: …` |
| **Proposed** | look at the list; comment on any you don't want |
| **Blocked / Budget** | fix the cause it names; raise `budget_usd` on main |

- **See everything:** `ap team status` (who is doing what, what waits for people, the team's spend). The same lines are on the **Autopilot backlog** issue on GitHub.
- **Add work:** small and concrete: **New issue → Autopilot task**. A new direction: edit the SPEC on main (autopilots propose the new parts).
- **Code yourself:** assign yourself to an issue (autopilots leave it alone) and work in your own checkout as usual; the autopilot works in `.autopilot/work/`.
- **Take a break without losing a claim:** label the issue `ap:hold`.

## Before the demo
1. Ctrl-C every autopilot (it stops Claude too; closing the terminal does the same).
2. Merge what's ready, `git pull` on main, run the demo from there.
3. `ap team status` for the final spend.

## If something goes wrong
- Main is broken: look at the **checks** on main's latest commit; file a task "fix main", or fix it yourself.
- An autopilot repeats itself or makes no progress: it stops as Blocked after 2 runs without progress. Read its last comment on the issue.
- A PR merged that shouldn't have: revert it on GitHub (the revert is a normal PR).
- More in `troubleshooting.md`.
