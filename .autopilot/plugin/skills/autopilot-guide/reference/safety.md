# Safety

Unattended runs need hard limits that don't depend on the AI behaving. There are four layers.

## 1. The container
- Runs as a non-root user.
- **Firewall**: all outgoing traffic is blocked except an allowlist (Anthropic, GitHub, PyPI/npm, ntfy, plus `.devcontainer/allowlist.txt`). IPv6 is blocked entirely. `ap doctor` checks example.com is unreachable.
- Inside the container, Claude's own sandbox (bubblewrap) is turned off, because it can't run under Docker; the container and firewall are the boundary instead. On the host, Claude's sandbox stays on.

## 2. Claude Code permissions (`.claude/settings.json`)
- Deny rules: force-push, pushing to main/master, tags, merging/approving/closing PRs, `gh api`, reading `.env`, `~/.ssh`, `~/.aws`, the env-file folder, editing the kit's settings and files.
- Allow rules for the normal work (pushes to `ap/*`, draft PRs, issue comments in team mode).
- Anything else goes through Claude Code's own safety check, which can refuse risky-looking commands (then the run stops Blocked and tells you).
- A plugin can't ship permissions, so these live in the project's settings.json. In team mode the supervisor passes your main checkout's settings to every run.

## 3. The guard hook (runs before every command and edit)
Blocks, among others:
- writing outside the project, editing SPEC, NOTES-HUMAN, settings, hooks, `.devcontainer`, `autopilot.toml`, `.autopilot/`, the spend ledger; rewriting JOURNAL (append only)
- force-push except lease-protected on its own `ap/` branch; pushes to main; tags; destructive git (`reset --hard`, `clean -f`, history rewrites); changing git config; `--no-verify`; commits on main
- merging, approving, closing PRs; closing, deleting, transferring issues; changing assignees; promoting issues to `ap:task`; deleting comments; pushing to another person's `ap/<login>/` branch
- direct GitHub API calls (`curl api.github.com`, `gh api`) and any use of the token
- `sudo`, pipe-to-shell, reading secret files, deselecting tests

Quoted prose (like a comment body) is ignored when checking command rules, so a comment that *mentions* "push to main" isn't blocked.

## 4. The supervisor
- Budget: hard cap from the SPEC; a per-run cap; killed runs are charged an estimate.
- Watchdog for hangs; one supervisor per checkout.
- In team mode it does the GitHub-side work (claims, syncing answers, heartbeats, parking extra proposals) deterministically, so the AI never needs `gh api`.

## Secrets
- Keys live only in `~/.config/autopilot/<project>.env` on your machine (outside the repo, chmod 600) and reach the container as environment variables.
- The AI can't read the env-file, `.env`, SSH keys or the token. Doctor fails if an env file is tracked in git.
- `GH_TOKEN` should be fine-grained and limited to the one repo: even a misbehaving run can only touch that repo.

## Your identity
Commits use **your** git name and email (passed in from the host) with a `Co-Authored-By: Claude` trailer. PRs and comments are made with your token, so GitHub shows them as yours; every autopilot comment ends with "Autopilot · @login" so people can tell.

## Trust in team mode
Issue and comment text from people without write access is dropped before the AI sees it. Text from the team is passed as information, clearly marked, and never overrides the SPEC or answered questions.
