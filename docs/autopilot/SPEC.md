---
# Set to true when this file is complete. The launcher refuses to start otherwise.
ready: false
profile: hackathon        # core | research | hackathon
budget_usd: 10       # total Claude spend cap for the whole build (all runs)
---

# SPEC

> Human-owned. The agent reads this and never edits it. Decisions go in DECISIONS.md;
> when a decision changes the goal, update this file so it stays current.

## Goal
<!-- One paragraph: what should exist when this is done, and for whom. -->

## Acceptance criteria
<!-- Numbered, each checkable by running something. The verifier checks these. -->
1.

## Constraints
<!-- Stack, licences, paid APIs and their caps, things that must not change. -->
- Lint: `just lint` · Tests: `just test`

## Out of scope
-

## Milestones (optional)
<!-- One per line: `M1 short name: what it includes`. Team mode makes GitHub milestones from them.
     Leave empty to let the coordinator plan. -->
