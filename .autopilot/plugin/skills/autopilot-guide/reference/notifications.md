# Notifications and how the autopilot writes

## Where you hear from it
- **Phone / browser**: ntfy. Put `AUTOPILOT_NTFY_URL=https://ntfy.sh/<your-own-long-random-topic>` in the env-file (`ap setup` offers one and sends a test). Subscribe to the same topic in the ntfy app. Anyone who knows a topic name can read it, so keep it unguessable and your own.
- **Desktop**: macOS/Linux notifications when running on the host (not from inside the container).
- **GitHub**: comments on issues and PRs, decision issues, PR descriptions.
- **Terminal**: the live view and the end-of-run summary.

## Phone notifications
Title: one keyword and the project. Body: up to three short lines. Tap opens the right page; a button goes straight to where you act.

| Title | When | Sound |
|---|---|---|
| `Question · <project>` | it stopped with questions. One question: the question (up to 2 lines), then `Default: …`. Several: `3 questions waiting` and the first two; tap opens the list | yes |
| `Blocked · <project>` | stopped on something outside its control: the reason | yes |
| `Budget · <project>` | budget used up: `$7.55 of $8 spent` | yes |
| `Review · <project>` | a PR was marked ready: task name, `PR #9 · <first check result>`. While an earlier announced PR is still waiting for you (open, no review or comment from a person), further ones are held back; once you've looked, the next notification lists them all (`3 PRs ready`) | quiet |
| `Merging · <project>` | hackathon auto-merge: task name, `PR #9 merges in 5 min`, `Comment on it to stop` | quiet |
| `Proposed · <project>` | hackathon auto-promote: `3 task(s) proposed`, the first one, `Tasks in 10 min unless you comment` | quiet |
| `Done · <project>` | only with `notify_done = true` under `[notify]` | quiet |

The same notification is never sent twice within 24 hours. Why so frugal: ntfy.sh's free tier limits messages per IP address per day, and a whole office shares one IP.

The project name is the repo name (a leading `autopilot-` is dropped); set `name = "…"` under `[notify]` in `autopilot.toml` to choose your own.

## How it writes (everywhere)
- **Six status words**: Done · Working · Needs your answer · Ready for review · Blocked · Budget used up.
- First line says what happened and whether you need to act.
- Every GitHub post ends with `Autopilot · @login`.
- Your words, not its internals: issue numbers and titles, "question #6", "checks passed".
- Evidence anyone can open (commits, PRs, copied result lines); long output folded away.
- A coloured GitHub alert box only when you have to act, with a checklist of what to do.
- Corrections edit its own last comment instead of adding new ones.
- No emoji.

The rules are in `skills/autopilot/VOICE.md` (for the AI) and `scripts/autopilot/voice.py` (for the supervisor).
