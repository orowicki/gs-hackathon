"""Stop hook for headless autopilot runs (active only when AUTOPILOT=1).

Order of checks:
1. Live subagents/workflows in `background_tasks` -> block: in -p mode, agents still
   running ~10 min after the turn ends are killed (v1 lost 3 agents this way).
2. STATE.md line 1 must be a stop-able status. RUNNING -> block (write RESUME or a
   terminal status first).
3. RESUME / DONE need the quality gate (default `just lint`, `just test`; override
   with AUTOPILOT_GATE="cmd1;;cmd2"). WAITING / BLOCKED / BUDGET skip it.
   Quality-gate refusals are capped at 3 per session so the agent can't be trapped.
"""

import json
import os
import re
import shlex
import subprocess
import sys

LIVE_TYPES = {"subagent", "workflow", "teammate", "local_agent"}
DONE_STATUSES = {"completed", "failed", "stopped", "killed", "cancelled", "done"}
STATUS_RE = re.compile(r"^STATUS:\s*(RUNNING|RESUME|WAITING|BLOCKED|BUDGET|DONE)\b")


def out_block(reason: str) -> None:
    print(json.dumps({"decision": "block", "reason": reason}))
    sys.exit(0)


def read_status(root: str) -> str | None:
    path = os.path.join(root, os.environ.get("AUTOPILOT_STATE_DIR") or "docs/autopilot", "STATE.md")
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as fh:
        m = STATUS_RE.match(fh.readline().strip())
    return m.group(1) if m else None


def live_agents(data: dict) -> list[str]:
    live = []
    for t in data.get("background_tasks") or []:
        if t.get("type") in LIVE_TYPES and (t.get("status") or "running").lower() not in DONE_STATUSES:
            live.append(f"{t.get('agent_type') or t.get('type')}: {t.get('description') or t.get('id')}")
    return live


def main() -> None:
    if os.environ.get("AUTOPILOT") != "1":
        sys.exit(0)
    data = json.load(sys.stdin)
    root = os.environ.get("CLAUDE_PROJECT_DIR") or data.get("cwd") or "."

    live = live_agents(data)
    if live:
        out_block(
            "Background agents are still running. In headless mode they are killed if you end "
            "your turn. Wait for their results (do not stop them unless they are stuck), record "
            "them, then stop.\nRunning:\n- " + "\n- ".join(live)
        )

    status = read_status(root)
    if status is None:
        out_block(f"{os.environ.get('AUTOPILOT_STATE_DIR') or 'docs/autopilot'}/STATE.md line 1 must be `STATUS: <RUNNING|RESUME|WAITING (..)|BLOCKED (..)|BUDGET|DONE>`. Fix it before stopping.")
    if status == "RUNNING":
        out_block("STATE says RUNNING. Before stopping, set line 1 to RESUME (to continue in a new process), WAITING/BLOCKED (needs the human, with the questions in DECISIONS.md), or DONE.")
    if status in ("WAITING", "BLOCKED", "BUDGET"):
        sys.exit(0)

    sid = re.sub(r"[^A-Za-z0-9_-]", "", data.get("session_id") or "unknown")
    attempts_file = os.path.join(root, "results/autopilot", f".stop_attempts-{sid}")
    os.makedirs(os.path.dirname(attempts_file), exist_ok=True)
    n = int(open(attempts_file).read() or 0) if os.path.exists(attempts_file) else 0
    if n >= 3:
        sys.exit(0)

    gate = os.environ.get("AUTOPILOT_GATE", "just lint;;just test")
    failures = []
    for cmd in [c.strip() for c in gate.split(";;") if c.strip()]:
        try:
            r = subprocess.run(shlex.split(cmd), cwd=root, capture_output=True, text=True, timeout=540)
        except (OSError, subprocess.TimeoutExpired) as e:
            failures.append(f"$ {cmd}\n{e}")
            continue
        if r.returncode not in (0, 5):  # pytest 5 = no tests collected (blank repo)
            failures.append(f"$ {cmd}\n{(r.stdout + r.stderr)[-1500:]}")
    if failures:
        with open(attempts_file, "w") as fh:
            fh.write(str(n + 1))
        out_block(
            f"Quality gate failed (attempt {n + 1}/3). Fix the cause; never loosen a check. "
            "If you can't, set `STATUS: BLOCKED (<reason>)` in STATE.md.\n\n" + "\n\n".join(failures)
        )
    sys.exit(0)


if __name__ == "__main__":
    main()
