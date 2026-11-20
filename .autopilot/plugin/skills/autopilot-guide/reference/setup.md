# Setup

About 15 minutes the first time. Commands say where they run.

## Needed on the host
- Docker: Docker Desktop or OrbStack on macOS; **Docker Engine** on Linux (not Podman: see `troubleshooting.md`). It must work without sudo (`docker run --rm hello-world`).
- Node.js and the devcontainer CLI: `npm i -g @devcontainers/cli`.
- Claude Code: `npm i -g @anthropic-ai/claude-code`.
- git, python3.
- Read access to the kit repo (private; ask the owner).

`just` and `uv` are not needed on the host; they're in the container.

## 1. Install the plugin (host, once per machine)
```bash
claude plugin marketplace add orowicki/autopilot
claude plugin install autopilot@autopilot-kit --scope user
```
Updates: `claude plugin marketplace update autopilot-kit` then `claude plugin update autopilot@autopilot-kit`.

## 2. Add the kit to a project (host)
- New project: in Claude, `/autopilot:init hackathon` (or `core`, `research`). It copies the devcontainer, settings, `autopilot.toml`, state templates and justfile recipes, vendors the plugin into `.autopilot/plugin`, and links `ap` into `~/.local/bin`.
- Update a project to a newer kit: `ap init --profile <profile>` in a terminal. Not `/autopilot:init`: Claude is deliberately blocked from changing the kit's own files. `ap init` refuses while a run is in progress.

## 3. `ap setup` (host)
Runs every step below and is safe to re-run:
1. Checks the host: git, python3, Docker (rejects Podman pretending to be Docker), the devcontainer CLI, `~/.local/bin` on PATH (prints the line to add if not).
2. Fills the env-file `~/.config/autopilot/<project>.env` (outside the repo, chmod 600). Asks with hidden input for:
   - `GH_TOKEN`: a fine-grained GitHub token for **this repo only**, with **Contents, Pull requests, Issues: Read and write** (team mode: also **Discussions: Read and write** for team notes, and **Actions, Commit statuses: Read** for hackathon auto-merge). Without it the autopilot records "ready to push" instead of pushing.
   - keys the project lists in `required_env` (e.g. an API key the app needs).
   - `AUTOPILOT_NTFY_URL`: optional phone notifications (it suggests a random topic and sends a test).
3. Builds the container (recreates it when the env-file changed: Docker only reads it at creation).
4. Checks the Claude login; if there is none, opens Claude in the container for `/login`. The login lives in a shared Docker volume: once per machine, kept across rebuilds and projects.
5. Runs `ap doctor`.

## Login options
- `/login` inside the container (what `ap setup` does): uses your Claude subscription.
- `CLAUDE_CODE_OAUTH_TOKEN` in the env-file (from `claude setup-token` on the host): no interactive step; for machines without a browser.
- `ANTHROPIC_API_KEY` in the env-file: billed per API call, and it takes priority over the subscription. Only if you mean to pay that way.

## `ap doctor`
Every check prints PASS / WARN / FAIL with a one-line fix. On a new project `SPEC ready` and `branch` fail until you fill the SPEC and switch to a branch: expected. Team mode adds `team login`, `team labels`, `team issues readable`.
