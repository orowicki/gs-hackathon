# Glossary

| Term | Meaning |
|---|---|
| **run** (internally "segment") | one Claude process, started by the supervisor; a build is many runs |
| **supervisor** | the Python program behind `ap autopilot`: starts runs, watches, budgets, notifies, syncs with GitHub |
| **coordinator** | the Opus session that plans and delegates within a run |
| **implementer / reviewer / verifier / scout** | the agents that write code, review diffs, check criteria, look things up |
| **milestone** (M1, M2…) | a runnable slice of the SPEC; one branch and one PR each (solo mode) |
| **task** | in team mode, one `ap:task` issue |
| **question / decision** (D-001…) | something only a person can decide; in team mode an `ap:decision` issue |
| **gate** | the checks (`just lint`, `just test`) a run must pass before it can say Working or Done |
| **guard** | the hook that blocks unsafe commands and edits |
| **stop gate** | the hook that won't let a run end with agents still running or the gate failing |
| **ledger** | `results/autopilot/ledger.jsonl`: one line per run with its cost |
| **watchdog** | kills a hung run and starts a fresh one |
| **on duty** | `--wait`: checking GitHub for work without spending anything |
| **claim** | an autopilot taking a task (assignee + marker comment) |
| **heartbeat** | the claim's comment, refreshed while it works; a claim with no heartbeat for the expiry time can be taken over |
| **stacked PR** | a PR built on another unmerged PR's branch |
| **restack / rebase** | moving a PR onto its updated base after that base changed or merged |
| **worktree** | a second checkout of the same repo; team mode's autopilot works in `.autopilot/work/` |
| **vendored plugin** | the project's own copy of the kit in `.autopilot/plugin` |
| **profile** | core, hackathon or research: rules on top of the core loop |
| **NOTES-HUMAN** | your channel to steer the autopilot |
| **env-file** | `~/.config/autopilot/<project>.env`: your keys, outside the repo |
| **delegate answer** | a teammate answering your question for you |
| **ap:hold** | pause a claim so it doesn't expire |
| **interface contract** | a file in `docs/autopilot/interfaces/` describing a shape several tasks depend on; changed only by PR |
| **team note** | a short message from one autopilot to the others, posted as a GitHub Discussion |
| **split** | a task broken into sub-issues (`ap:split`); the parent closes when all parts are done |
