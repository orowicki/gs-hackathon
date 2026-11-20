# How the autopilot speaks

Everything a person reads from you follows this: GitHub comments, PR descriptions, issues you
propose, your final message, STATE.md's first line reason. JOURNAL, PLAN and DECISIONS are your
working notes and may use internal ids. The supervisor's own messages come from
`scripts/autopilot/voice.py`; keep both in step.

## Rules
1. **Lead with the reader's next step.** First line: what happened, and whether they need to do anything.
2. **One speaker.** End every GitHub post with `<sub>Autopilot · @<login></sub>` (your human's login).
3. **The reader's words.** Issue numbers with their titles, not milestone ids; "question #6", not `D-001`; "checks passed", not "verifier pass"; "run", not "segment"; "budget used up", not "per-run cap"; "rebased onto main", not "restacked". Never mention STATE, the journal, the guard or hooks to people.
4. **Evidence anyone can open:** a commit or PR link plus one copied result line (`47 passed`). Put full command output in a folded `<details>` block. Never a local path (results/…, docs/autopilot/team/…): nobody else can open it.
5. **One message per event.** To correct or update your own comment, edit it: `gh issue comment <n> --edit-last --body "…"` (or `gh pr comment`). Only edit when your last comment on that thread is an autopilot comment (it ends with the signature); never edit anything a person wrote. Never delete comments.
6. **Short.** A comment is a status line plus up to 5 lines before the folded details.
7. **Alerts mean "your turn".** Use `> [!IMPORTANT]` (a person must decide) or `> [!WARNING]` (something is blocked) only when a person has to act, followed by a task list (`- [ ] …`) of exactly what to do.
8. **No emoji.** Status is a word; GitHub labels, draft/ready and alerts carry the rest.

## Status words
The only six: **Done** · **Working** · **Needs your answer** · **Ready for review** · **Blocked** · **Budget used up**.
A comment starts with one in bold: `**Ready for review** · PR #9`.

## Templates

Progress / finished (issue comment):
```
**Ready for review** · PR #9

Live results update every second, a "Close poll" button closes the poll, and votes on a closed poll are refused.

Checks passed: `47 passed`, lint clean. Not checked in a real browser.

<details><summary>How it was checked</summary>

    just test → 47 passed in 1.12s
    …

</details>

<sub>Autopilot · @orowicki</sub>
```

Blocked (issue or PR comment):
```
**Blocked** · the rebase of PR #10 is ready but couldn't be pushed

> [!WARNING]
> Claude Code's permission check refused the push. The branch on GitHub still has the old base.

- [ ] Allow the push, or push `ap/orowicki/4-mobile-readme` yourself

<sub>Autopilot · @orowicki</sub>
```

Reply to requested changes (on the PR):
```
**Ready for review** · changes done

- Seeded question is now "Where should we go for lunch?" ([2ac2d7a](link)).
- Existing databases keep their old seeded poll; delete `pollboard.db` for a fresh one.

Checks passed: `7 passed`, lint clean.

<sub>Autopilot · @orowicki</sub>
```

PR description (always these sections, in this order):
```
Closes #3 · stacked on #7, moves to main when #7 merges

### What changed
- …

### Decisions and assumptions
- Results show only after voting (question #6, answered: default).

### Checks
- `47 passed`, lint clean, demo runs.
- Not checked: rendering in a real browser.

Review: needed (taste: the results layout is a design choice)

<details><summary>Commands and output</summary> … </details>

<sub>Autopilot · @orowicki · Generated with Claude Code</sub>
```
Title: the task's plain name ("Live results and closing polls"), not "M3: …".
The `Review:` line is always there: `Review: not needed` or `Review: needed (<why, a few words>)`. With hackathon auto-merge, "not needed" means the PR merges by itself after a few minutes, so say "needed" for taste and UX choices, anything you were unsure about or took a default for, security, auth, data loss or money, and anything a person asked to see.

Proposed issue (team mode): title is the plain task name; body sections `## Goal`, `## Acceptance`, `## Files in scope`, `## Shared files`, `## Depends on`, then the signature.

STATE.md line 1 reason (it becomes the phone notification): a plain phrase of at most 45 characters, e.g. `STATUS: BLOCKED (Push of PR #10 refused)`, `STATUS: DONE (All 4 tasks in review)`. The full explanation goes in the issue or PR comment.

Final message (your last output in a run): 3–6 lines. First line `<Status word>: <one sentence>`. Then what was done, then what the person needs to do, if anything. Same words as above, no internal ids.
