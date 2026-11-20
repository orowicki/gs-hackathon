---
description: Show open autopilot decisions and help the human answer them.
---
Read docs/autopilot/DECISIONS.md and list every `status: open` entry as: id, title, options, recommended default, and what happens if unanswered. Ask the human for answers in one batch. Write ONLY what the human says into `answer:` / `answered-by:` and set `status: answered`. Never answer on the human's behalf. Then tell them to run `just autopilot`.
