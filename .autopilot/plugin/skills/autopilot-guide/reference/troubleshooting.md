# Troubleshooting

Start with `ap doctor`: every FAIL has a one-line fix.

| You see | Cause | Fix |
|---|---|---|
| `ap: command not found` | `~/.local/bin` isn't on PATH | `ap setup` prints the line to add to `~/.zshrc`/`~/.bashrc`; open a new terminal |
| `bwrap`/`socat` not installed | `claude` started on the host in the project folder, where the project turns on Claude's sandbox | use `ap chat` (container), or install `bubblewrap` and `socat` on Linux |
| `FAIL container engine: Podman`, or `FAIL egress firewall blocks` | Podman, not Docker: its networking bypasses the firewall | install Docker; check `docker --version` doesn't mention podman, `unset DOCKER_HOST` if it points at `podman.sock`, VS Code `dev.containers.dockerPath` = `docker`; then `devcontainer up --workspace-folder . --remove-existing-container` and log in again |
| `FAIL workspace readable` (Fedora) | SELinux blocks the project mount | tell the kit owner |
| Docker "permission denied" | user not in the docker group | `sudo usermod -aG docker $USER`, log out and in |
| Changed the env-file, nothing changed | Docker reads it only when the container is created | `ap setup` (or `devcontainer up … --remove-existing-container`) |
| `FAIL GitHub token sees repo` / `team issues` | token missing access or a permission | fine-grained, this repo, Contents + Pull requests + Issues: Read and write |
| `FAIL branch: main` / `FAIL SPEC ready` | new project | solo mode: `git switch -c ap/run` (team mode never needs it; update the kit if doctor still asks); fill the SPEC, `ready: true` |
| `/autopilot:init` can't update `.autopilot/plugin` | Claude is blocked from the kit's own files on purpose | `ap init --profile <profile>` in a terminal |
| `Refusing to start: another autopilot is already running here` | a run is going in this checkout | wait for it, or stop it (Ctrl-C in its terminal) |
| Stopped with **Needs your answer** | normal: it needs you | `ap decide`, then `ap autopilot` (team: answer the issue; `--wait` continues by itself) |
| **Blocked**: a permission was refused | Claude Code's safety check refused a command | read the reason; it says what to allow or do by hand. Don't loosen safety rules to get past it; ask the kit owner if a legitimate command is refused |
| **Blocked: no progress** | two runs changed nothing | read the last journal entries and the live view; usually an unclear SPEC or a broken environment. Fix, set `STATUS: RESUME`, run again |
| **Budget used up** | `budget_usd` spent | raise it in the SPEC; `ap spend` shows the total |
| A run seems hung | stuck tool or agent | the watchdog kills it after `idle_timeout_min`/`silent_timeout_min` and restarts |
| A question answered on GitHub isn't picked up | only your own `answer:`, a teammate's `delegate answer:`, or your thumbs-up count | check the wording; with `--wait` it syncs within `poll_minutes` |
| Requested changes on your own PR do nothing | GitHub won't let the PR author "Request changes", and its PRs are yours | comment on the PR starting with `changes:` |
| A stacked PR isn't linked to its issue | GitHub only links PRs that target main | it links once retargeted to main, after the base merges |
| Your checkout changed branch while it ran | (solo mode) it works in your checkout | don't switch branches during a solo run; team mode works in its own worktree |
| `ap init` refuses | a run is in progress | wait for it to stop |
