# Why it works this way

The kit came out of a first version (v1) used to build a live sports commentator, then eight test runs. Most rules trace back to something that went wrong.

## From v1 (20 runs, $83.69, 19.9 hours)
- **6.3 of the 19.9 hours were one hang.** Hence the watchdog, including a rule for a frozen process that still lists agents as running (found again in test run 6).
- **Spend was misread by 10x** (summing per-message totals gave $842 instead of $83.69). Hence the ledger takes the maximum per session and records one line per run.
- **Work was lost twice** when agents still running at the end of a run were killed. Hence the stop gate refuses to end a run while agents are running, and the coordinator must wait for every agent it starts.
- **8 of 20 runs ended waiting for the owner**, often one question at a time. Hence questions are batched with a recommended default, work continues around them, and `ap decide` makes answering quick.
- **6 runs ended on the environment** (not logged in, keys empty, wrong permissions, firewall gaps). Hence `ap doctor` and `ap setup`: every check maps to one of these.
- **205 of 214 commits had an AI identity.** Hence commits use your identity with a Co-Authored-By line.
- **The coordinator was 48 % of spend.** Hence it delegates to cheaper agents and keeps its own context small.

## Design choices
- **One fresh process per run**, never resuming a session: a resumed session double-counts spend, and fresh runs make crashes cheap. All state is on disk.
- **The supervisor is plain Python**: budget, watchdog, claims and notifications must not depend on the AI behaving.
- **Draft PRs and human merges only**: you stay the gate for what lands.
- **Stacked branches**: work continues while earlier PRs wait for review.
- **A container with a firewall** instead of Claude's own sandbox, which can't run inside Docker.
- **GitHub Issues for teams**: everyone already has them, people can see and steer everything, and there's no server to run. Claude Code has nothing built in for coordinating different people's sessions (checked 2026-11-19).
- **Claims by assignee + comment, earliest wins**: GitHub has no atomic "take this issue".
- **Each autopilot in its own worktree with local notes** (team mode): in test run 8 a person switching branches mid-run moved the autopilot's files and put its notes on main.
- **Only your own answer counts, by default**: a decision is yours; `delegate answer:` is deliberately different so nobody answers for you by accident.
- **`changes:` comments**: the autopilot's PRs are made with your token, and GitHub won't let an author "Request changes" on their own PR.
- **One voice, no emoji**: notifications must be readable at a glance on a locked phone; status comes from each channel's own tools.

## The test runs
Eight dry runs (about $16 in total) covered: a toy CLI, questions and resume, budget stops, a hackathon app from an empty repo, a research experiment with a pre-registered rule, fault injection (hangs, two supervisors, killed runs) and a full team-mode run on GitHub with requested changes, merges and rebases. Details: `docs/DRYRUNS.md` in the kit repo.
