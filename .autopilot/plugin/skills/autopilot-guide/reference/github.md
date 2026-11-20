# Branches and pull requests

## Branches
- Solo mode: one branch per milestone, `ap/m<N>-<slug>`. Milestone 1 branches from main; later ones **stack** on the previous milestone's branch until that one is merged.
- Team mode: `ap/<login>/<issue>-<slug>` per task, from main or stacked on a finished dependency's branch.
- The autopilot never pushes to main, never tags, never force-pushes except `--force-with-lease` on its own `ap/` branch after a rebase, and never commits on main.

## Draft and ready
| PR state | Meaning | Who sets it |
|---|---|---|
| Draft | the autopilot is still working on it | the autopilot opens it as a draft |
| Ready for review | done: checks passed, verified against the criteria | the autopilot marks it ready (and you get a Review notification) |
| Back to draft | it's working on it again (requested changes, a rebase) | the supervisor/autopilot |
| Merged | accepted | a person; or, with hackathon auto-merge, the supervisor (below) |

GitHub won't merge a draft. Approving and closing are always yours; merging too, except for hackathon auto-merge.

## Hackathon auto-merge (team mode)
On by default with `profile: hackathon` (`[team] auto_merge`). Every PR says `Review: needed (why)` or `Review: not needed`. Your supervisor merges **your own autopilot's** ready PR (squash) when all of these hold:
- it says `Review: not needed` (the AI must say "needed" for taste, UX, uncertainty, defaults it took, security or money);
- it targets main (stacked PRs wait for their base);
- it doesn't touch interface contracts, the SPEC, `.github/`, `.devcontainer/`, `.claude/`, `autopilot.toml`, the justfile or dependency and lock files;
- GitHub checks passed (running checks just delay it), and it has no conflicts;
- nobody commented or reviewed since it became ready, and neither the issue nor the PR has `ap:hold`;
- `auto_merge_delay_min` (5) minutes passed since the **Merging** notification.

**To stop it:** comment anything on the PR or the issue, review it, or add `ap:hold`. It then waits for you like any PR (you get a Review notification). New commits restart the timer. After a merge it comments on the issue; revert on GitHub if it was wrong. It only merges while `ap autopilot --wait` (or a run) is going.

## PR descriptions
Always: `Closes #N` (team mode) and stacking note · What changed · Decisions and assumptions (including defaults it took for unanswered questions) · Checks (copied results, and what was **not** checked) · folded commands and output.

## Asking for changes
- **"Request changes"** review on the PR, or
- a **PR comment or review starting with `changes:`**: needed on your own autopilot's PRs, because its PRs are opened with your token, so GitHub sees you as the author and won't let you "Request changes" on them.

The autopilot (team mode: the supervisor, within one poll) reopens the task, turns the PR back to draft, fixes it **on the same branch and PR**, replies to each point, re-verifies and marks it ready again. Only people with write access count. If it disagrees with a change, it asks a question instead of skipping it.

In solo mode, requested changes are read when the autopilot works on that milestone again; for a finished milestone, also add a line to NOTES-HUMAN.md.

## Stacked PRs and merging
- A stacked PR's base is another `ap/` branch. GitHub only links `Closes #N` to the issue (and closes it on merge) when the PR targets the default branch; stacked PRs show the link once they're retargeted to main.
- **Merge stacked chains in order, with "Create a merge commit"** (not squash), and let GitHub delete the branch. GitHub then retargets the next PR to main. Squash leaves the next PR carrying the old commits until it's rebased.
- When a PR's base moves (new commits on it, or it was merged or closed) or a PR on main gets a conflict, the autopilot reopens its own PR, rebases, re-verifies and marks it ready again. One chain of 3 PRs takes 3 short runs.

## What's linked where
- Progress and status comments go on the issue (team mode) or PR.
- Evidence is commits, PR links and copied result lines, never local file paths.
