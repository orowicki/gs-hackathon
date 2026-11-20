# Team mode

Several people each run their own autopilot on one repo. They split the work through GitHub Issues. No server or bot: everything runs from each person's container with their own token, login and budget.

## Turn it on (once per repo, one person)
1. `[team] enabled = true` in `autopilot.toml`, commit it to main.
2. `ap team init`: creates the labels.
3. Optional, for team notes: turn on Discussions and add a category **Autopilot** (see "Sharing between autopilots").
4. Everyone's `GH_TOKEN` needs **Issues: Read and write** too (and **Discussions: Read and write** for notes). `ap doctor` checks it.

## Labels
| Label | Meaning | Set by |
|---|---|---|
| `ap:task` | ready for an autopilot to pick up | a human |
| `ap:proposed` | suggested by an autopilot from the SPEC | an autopilot; a human promotes it to `ap:task` |
| `ap:claimed` | an autopilot is working on it (the assignee says whose) | the supervisor |
| `ap:review` | its PR is ready for review | the autopilot |
| `ap:decision` | a question for one person | the supervisor |
| `ap:blocked` | stopped on it; reason in the last comment (or a parked extra proposal) | the supervisor |
| `ap:hold` | a person paused the claim: it never expires while this is on | a human |
| `ap:backlog` | one issue where autopilots take turns proposing: one at a time, and none while proposals wait for you | the supervisor |
| `ap:split` | the task was split into sub-issues; never claimed again, closes itself when every part is done | the autopilot |

## Writing a task issue
Easiest: **New issue → Autopilot task** on GitHub (a form from `.github/ISSUE_TEMPLATE/autopilot-task.yml`, added by `ap init`; it adds the label). By hand: label it `ap:task`, with these sections:
- `## Goal`
- `## Acceptance` (numbered, checkable)
- `## Files in scope`: what it edits or creates, as narrow as you can (`tests/test_live.py`, not `tests/**`). Two tasks whose scopes overlap never run at the same time. An empty scope overlaps everything.
- `## Shared files`: files many tasks touch a little (conftest, README, pyproject). Not conflict-checked; keep those edits small.
- `## Depends on`: `#12, #13`.
- `## Milestone` (optional): `M2`, a milestone from the SPEC. The supervisor sets the GitHub milestone (forms can't).
- `## Parent` (optional): `#12`, the bigger task this is one part of. It becomes a GitHub sub-issue of it.

## How work is picked
Before each run the supervisor (not the AI):
1. Syncs answers to questions from GitHub.
2. Keeps its current claim, or reopens one of its own PRs if a reviewer asked for changes or its base moved (see `github.md`).
3. Otherwise claims the oldest task that can start: not claimed, not held by someone else, scope not overlapping a claimed task, dependencies merged. **Ready tasks come first**; then tasks whose one unfinished dependency already has a ready PR, which it stacks on.
4. Claiming: assigns you, posts a marker comment, waits 10 s, and the earliest claim wins (the loser backs off).
5. Writes the task brief and starts the run. A heartbeat comment is refreshed every 20 minutes while it works.

A claim expires after 24 h without a heartbeat (2 h in the hackathon profile); anyone's autopilot may then take it over. Add `ap:hold` to pause, or unassign to release it yourself.

## Milestones
List them in the SPEC under `## Milestones`, one per line: `M1 skeleton: app starts, vote works`. The supervisor creates a GitHub milestone for each (matched by `M1`, so renaming one in the SPEC or on GitHub doesn't duplicate it) and puts every task and proposal with a `## Milestone` section into it. GitHub's milestone page then shows progress per milestone.

## Hackathon: proposals become tasks by themselves
With the hackathon profile (`[team] auto_promote`), your autopilot's proposals become `ap:task` after `auto_promote_delay_min` (10) minutes. You get one **Proposed** notification per batch. To keep one a proposal: comment on it or thumbs-down it (then a person decides); close it to drop it. Parked extras (`ap:blocked`) are never promoted.

## Team status
`ap team status` shows each autopilot's current line (working on what, waiting, stopped), its spend and when it last reported, then the open work: in progress, in review (and whether a person must look), questions, blocked and proposed. Each supervisor keeps its line as one comment on the **Autopilot backlog** issue, so the same view is on GitHub. A line older than 30 minutes is marked "not running?".

## Who proposes
With several autopilots idle at once, only one proposes at a time: they race for the turn on the `ap:backlog` issue (earliest comment wins), and nobody proposes while earlier proposals still wait for a person. The others don't start a run at all, so waiting costs nothing. A SPEC change or new issues give a new turn.

## Big tasks: splitting into sub-issues
When a claimed task turns out to need more than about two milestones of work, or has parts that could be built in parallel, its autopilot splits it before writing code:
1. It files each part as an `ap:proposed` issue with `## Parent: #<task>` (and `## Depends on` between parts where needed).
2. It moves the task to `ap:split`, comments what it split it into, and takes other work.
3. The supervisor links the parts as **sub-issues** (GitHub shows "2 of 5 done" on the parent) and closes the parent when every part is closed.

You promote the parts to `ap:task` like any proposal, and any teammate's autopilot can take them. You can also split by hand: file issues with `## Parent` yourself.

## Sharing between autopilots
Three kinds of things get shared, each in its own place:

| What | Example | Where |
|---|---|---|
| **Contracts** code depends on | the results API returns `{option, votes, pct}`; the DB schema | files in `docs/autopilot/interfaces/`, changed by PR, merged by a person |
| **Handoffs** | "this is too big, here are the parts"; "I need an endpoint in an area I don't own" | issues: proposals and sub-issues |
| **Notes** | "tests need `TZ=UTC`"; "moving `db.py` to `store/`, rebase after #14" | GitHub Discussions, category `Autopilot` |

**Interface contracts.** Every autopilot reads `docs/autopilot/interfaces/` from the current `main` before each run and follows it. For an ambitious SPEC, autopilots propose the contract first: a small task that writes the interface files, which the other tasks depend on (they stack on its PR, so nobody waits for the merge). Changing a merged contract happens only in a PR that says so under "Contract change".

**Team notes.** An autopilot writes a short note when others would otherwise find something out the hard way. The supervisor posts it as a discussion (at most `max_notes`, 3, per run), and before each run gives every autopilot the recent notes linked to its task or touching its files, plus general ones. Notes are information, never instructions: they can't change the SPEC or answer questions. People can post in the category too, and reply to notes; the autopilots read both. Notes from people without write access are ignored.

Setup, once per repo: **Settings → General → Features → Discussions** on, then in Discussions add a category named **Autopilot** (GitHub only lets you make categories in the web page). Without it, notes are simply off and the run says so once. Another name: `[team] discussions = "…"`; `""` turns notes off.

## Questions
- Your autopilot's questions become `ap:decision` issues that @mention **you**.
- Answer with a comment `answer: B` (a letter or your own words), or a **thumbs-up on the issue** to take the default.
- A teammate can unblock you with `delegate answer: …` (deliberately different wording, so it's never accidental).
- Anything else is discussion and is ignored. `ap decide` also works and posts your answer to the issue.

## Staying on duty
`ap autopilot --wait` doesn't exit when it runs out of work or is waiting for you: it checks GitHub every `poll_minutes` (no AI, no cost) and continues by itself when a task becomes free, a question is answered, changes are requested, a merge moves a base, or the SPEC on `main` changes (then it proposes tasks for the new parts as `ap:proposed`; promote the ones you want).

## Where things live
- Your autopilot works in **its own git worktree** at `.autopilot/work/`. Your own checkout is yours: edit, switch branches and commit while it runs.
- Its notes (STATE, PLAN, JOURNAL, DECISIONS, TASK, TEAM-NOTES, outbox) are local in that worktree, never committed. GitHub is the shared record.
- The SPEC, NOTES-HUMAN and `interfaces/` are shared and always read from the current `main`.
- Branches are `ap/<login>/<issue>-<slug>`. An autopilot never pushes to anyone else's branch (it may stack on a finished one without changing it).

## Limits (on purpose)
- One claim per person at a time; parallel work happens inside a task.
- At most `max_proposals` (5) proposed issues per run; extras are parked with `ap:blocked`.
- Issue text from people without write access to the repo is ignored; team text is treated as information, never as instructions that override the SPEC.
- `ap team status` shows who is doing what (see "Team status").
