# Running

## Start
```bash
git switch -c ap/run          # host; solo mode never runs on main (team mode doesn't need this)
# fill docs/autopilot/SPEC.md: goal, numbered acceptance criteria, then ready: true
ap doctor                     # fix every FAIL
ap autopilot                  # runs in the container; live view in your terminal
```
`ap <recipe>` runs `just <recipe>` inside the project's container from the host, from any subfolder, and starts the container if needed. Plain `ap` opens a shell in it.

## What happens
The supervisor starts Claude for one **run** (a fresh process each time). The coordinator reads the state, plans, delegates, checks, commits, pushes and writes STATE.md line 1. The supervisor then either starts the next run (status Working) or stops. Each run starts fresh from the files, so a crash or restart loses little.

## How it stops
| Status | Meaning | Exit code | What you do |
|---|---|---|---|
| **Done** | every SPEC criterion verified (team mode: no work left) | 0 | review and merge the PRs |
| **Needs your answer** | questions in DECISIONS.md (team mode: `ap:decision` issues) | 0 | `ap decide` (or answer on GitHub), then `ap autopilot` |
| **Blocked** | something outside its control: a missing key, a refused permission, no progress in 2 runs, a broken environment | 3 | read the reason in the live view or STATE.md, fix it, set line 1 to `STATUS: RESUME`, run again |
| **Budget used up** | the SPEC's `budget_usd` is spent | 4 | raise `budget_usd` in the SPEC, run again |

"Needs your answer" is not a failure, so it exits 0.

## Answering questions
- **`ap decide`**: shows each open question with options and the recommended default. Type a letter, Enter for the default, your own words, `s` to skip, `q` to quit. It writes the answers and offers to set the status back to Working.
- Or edit DECISIONS.md: fill `answer:` (a filled answer counts even if `status: open` was left).
- Or `/autopilot:decide` in a Claude session in the project.
- Team mode: answer on the GitHub issue instead (see `team-mode.md`).

The autopilot batches questions, keeps working on anything they don't block, and in the hackathon profile takes the recommended default for most things (and says so in the PR).

## Steering it
- `docs/autopilot/NOTES-HUMAN.md`: hints and corrections ("use argparse", "stop touching the CSS"). Read at the start of every run; the autopilot can't write it.
- Change the SPEC: the autopilot never edits it. If it disagrees with the SPEC it asks a question.
- Requested changes on a PR (see `github.md`).

## Budget and spend
- `budget_usd` in the SPEC frontmatter is the total for the whole build across all runs.
- Each run is capped at what's left minus a margin; the supervisor won't start a run with less than `min_segment_usd` left.
- `ap spend` shows the total; `results/autopilot/ledger.jsonl` has one line per run (cost by model, agents, status).
- A run killed by the watchdog never reports its cost; it's charged a conservative `unknown_segment_usd` (default $1).
- Rough guide from the dry runs: a small CLI or web feature $1–2; a 4-milestone hackathon app $6–8.

## Watchdog
- No output and no agents running for `idle_timeout_min` (20): the run is stuck, kill and restart.
- No output at all for `silent_timeout_min` (60), even with agents listed as running: hung, kill and restart.
- Finished but the process doesn't exit within `exit_grace_s`: kill.
- Two runs in a row with no new commit or journal entry: Blocked ("no progress").
- Only one supervisor can run per checkout (a lock file); a second refuses.

## Other commands (all `ap <recipe>`)
- `ap chat`: interactive Claude in the container with the kit's plugin (`/autopilot:status`, `/autopilot:decide`).
- `ap replay <log>`: replay a run log through the live view.
- `ap doctor`, `ap spend`, `ap team …` (team mode).
- Host only: `ap setup`, `ap init`, `ap eject` (removes the kit at the end of a project; history is kept under `docs/history/autopilot`; nothing is committed for you).
