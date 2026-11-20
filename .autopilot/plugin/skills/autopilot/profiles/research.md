# Profile: research

For projects where the result is a measured claim (model quality, latency, accuracy).
- **Non-negotiables** live in the project's `AGENTS.md` (template in `profiles/research/AGENTS.md`). Read it at every resume.
- **Eval hygiene:** the eval set is never used for prompt design, few-shot examples or tuning. Tune on a dev split and run eval only at pre-registered gates. Count eval runs against the cap in SPEC.
- **Pre-registration is mandatory:** the decision rule and the pick-best rule go in JOURNAL before any eval run. No changing the rule after seeing data; that needs a DECISIONS entry from the human.
- **The rule must face the right noise:** run-to-run SD alone understates uncertainty when items vary more than runs (dry run 5: item spread was ~6× run spread). Pre-register a paired, item-level comparison too, e.g. "adopt iff the mean paired item difference > 0 with a paired t ≥ 2 (or a sign test p < 0.05) **and** the difference exceeds the larger run-to-run SD".
- **Report readably:** REPORT rounds to 2–3 decimals and links the result file holding the raw values; never retype numbers by hand.
- **Steady judge:** model-graded metrics use ≥ 3 judge calls per item, averaged, with a fixed judge prompt and model recorded in JOURNAL.
- **Extra agents:**
  - `research-critic` before any claim reaches REPORT or a decision.
  - `experiment-runner` for every run (records commit, command, cost; copies metrics).
  - `ml-reviewer` on data, eval or model code.
  - `literature-scout` for source searches (opens what it cites).
- **Licences:** record the licence of any dataset, model, voice or footage in JOURNAL before using it.
- **Cost logging:** every paid API call is logged with tokens and cost. The total in REPORT comes from logs, not estimates.
- **Cleanup refactors** need a behaviour-invariance proof: identical offline outputs before and after, plus tests.
