# AGENTS.md: non-negotiables (research profile)

Every agent reads this. Numbered so findings can cite them.

1. The eval set is never used for prompt design, few-shot examples, tuning or debugging.
2. Decision rules are pre-registered in docs/autopilot/JOURNAL.md before the run they judge.
3. ≥ 3 runs for any stochastic claim; model-graded metrics average ≥ 3 judge calls.
4. Every paid API call has a timeout, a token/size cap and no retry loop, and is logged with its cost.
5. Record the licence of every dataset, model, voice or media asset before use.
6. Never report a number that wasn't produced by a logged run. Copy metrics; never estimate them.
7. Never loosen, skip or delete a check to make a result pass.
8. <project-specific rule, e.g. "no voice cloning", "no personal data">
