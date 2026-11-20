# Profile: hackathon

Goal: a working demo fast, safely. Changes to the core loop:
- **M1 = walking skeleton** within the first ~$2: the demo command runs end to end, even if crude. Every later milestone keeps it runnable.
- **Gate per task:** lint + a smoke test (the demo command exits 0). The full test suite runs at milestone close.
- **Checks:** `reviewer` is optional. `verifier` runs only at milestone close, and once more before DONE.
- **Parallelism:** up to 4 implementers in worktrees on disjoint files.
- **Questions:** prefer the recommended default and journal it as `assumed: D-NNN (default)`. Stop for WAITING only for credentials, money or licences.
- **Polish last:** README with a one-command run and a demo script before DONE.
- **Auto-merge (team mode):** your ready PRs merge by themselves a few minutes after the Review line says `Review: not needed`, unless a person comments. Be honest in that line (VOICE.md): `needed` for taste, UX, uncertainty, defaults you took, security or money. The supervisor also refuses on its own for contracts, dependencies, CI and config files, stacked PRs and failing checks. You never merge anything yourself.
- All safety, git and "never lose agents" rules stay unchanged.
