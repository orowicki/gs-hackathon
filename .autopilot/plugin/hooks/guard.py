"""PreToolUse guard (second line of defence behind deny rules and the container).

Exit 2 = block, with the reason on stderr (shown to the model).
Rules: no writes outside the project; protected and human-owned files; JOURNAL is
append-only; dangerous shell patterns; git/gh rules from DESIGN-v2 §14.2.
"""

import json
import os
import re
import sys

STATE_DIR = "docs/autopilot/"
PROTECTED = (".claude/settings.json", ".claude/settings.local.json", ".claude/hooks/",
             ".devcontainer/", ".git/", ".env", "autopilot.toml", ".autopilot/",
             STATE_DIR + "SPEC.md", STATE_DIR + "NOTES-HUMAN.md",
             "results/autopilot/ledger.jsonl")
OWN_DIR = (os.environ.get("AUTOPILOT_STATE_DIR") or "docs/autopilot").rstrip("/") + "/"
ME = os.environ.get("AUTOPILOT_LOGIN", "")
APPEND_ONLY = (OWN_DIR + "JOURNAL.md",)
TEAM_DIR = "results/autopilot/team/"

BASH_RULES = {
    # git
    r"\bgit\s+push\b[^\n;&|]*\s(-f\b|--force(?!-with-lease)|\+\S)": "force push (use --force-with-lease on ap/* only)",
    r"\bgit\s+push\b[^\n;&|]*\s--force-with-lease\b(?![^\n;&|]*\bap/)": "--force-with-lease is only allowed on ap/* branches",
    r"\bgit\s+push\b[^\n;&|]*(\b(main|master|HEAD)\b(?!/)|:main\b|:master\b)": "push to the default branch",
    r"\bgit\s+push\b[^\n;&|]*(--tags|--mirror|--all|refs/tags)": "pushing tags/mirror/all",
    r"\bgit\s+push\b[^\n;&|]*\s(--delete|-d|:)\s*(?!ap/)\S": "deleting a non-ap/* remote branch",
    r"\bgit\s+tag\b": "tags are not used (cite path + run id)",
    r"\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|filter-branch|filter-repo|update-ref\s+-d)": "destructive git",
    r"\bgit\s+config\b(?![^\n;&|]*--get)": "changing git config (identity comes from the host)",
    r"--no-verify\b": "skipping git hooks",
    # gh
    r"\bgh\s+pr\s+(merge|review|close)\b": "the agent never merges, approves or closes PRs",
    r"\bgh\s+pr\s+create\b(?![^\n;&|]*--draft)": "PRs must be opened with --draft",
    r"\bgh\s+(api|repo|release|secret|variable|ruleset|workflow\s+run|auth)\b": "gh command outside the allowed set",
    r"api\.github\.com|uploads\.github\.com": "direct GitHub API calls (use the allowed gh commands; the supervisor does claims and syncs)",
    r"\$\{?(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN)\b|\b(printenv|env)\b[^\n|;&]*\b(GH_|GITHUB_)TOKEN": "using or reading the GitHub token directly",
    r"\bgh\s+issue\s+(close|delete|transfer|lock|unlock|pin|unpin|reopen|develop)\b": "the agent never closes, deletes, moves or locks issues",
    r"\bgh\s+issue\s+edit\b[^\n;&|]*--(add|remove)-assignee\b": "assignees are set by the supervisor's claim, not the agent",
    r"\bgh\s+(issue|pr)\s+comment\b[^\n;&|]*--delete-last\b": "never delete comments (edit your own last one instead)",
    r"\bgh\s+issue\s+(create|edit)\b[^\n;&|]*(--add-label|--label|-l)[=\s]+['\"]?[^\s'\"]*\bap:(task|claimed|decision)\b": "only humans promote issues to ap:task; claims and decisions are the supervisor's",
    # system / secrets
    r"\brm\s+-[a-z]*r[a-z]*\s+(/|~|\$HOME|\.\.)(\s|$|/)": "rm outside project",
    r"\b(curl|wget)\b[^\n]*\|\s*(sh|bash|zsh|python)": "pipe-to-shell",
    r"\bsudo\b|\bchmod\s+-R\s+777\b|\bmkfs\b|\bdd\s+if=": "system-level command",
    r"\b(cat|less|head|tail|cp|scp|grep|base64)\s+[^\n]*(\.env\b|id_rsa|\.ssh/|\.aws/|\.netrc)": "secret access",
    r"\b(pytest|just\s+test)\b[^\n]*(--deselect|-k\s+['\"]?not\b)": "deselecting tests",
    # shell writes to protected files
    r"(>|\btee\b[^\n|]*)\s*\S*(\.claude/settings|\.claude/hooks/|\.devcontainer/|NOTES-HUMAN\.md|SPEC\.md|ledger\.jsonl|\.autopilot/|autopilot\.toml)": "shell write to a protected file",
    r"(sed\s+-i|perl\s+-[a-z]*i)[^\n]*JOURNAL\.md": "JOURNAL.md is append-only",
    r"(?<!>)>\s*\S*JOURNAL\.md": "JOURNAL.md is append-only (use >> or Edit at the end)",
}


def branch_rules(cmd: str, root: str) -> None:
    """No commits, merges or rebases onto main/master in the agent's checkout (dry run 8:
    with no task branch, the coordinator committed its notes on main)."""
    if not re.search(r"\bgit\s+(commit|merge|rebase|cherry-pick|revert|am)\b", cmd):
        return
    import subprocess
    try:
        cur = subprocess.run(["git", "branch", "--show-current"], cwd=root, capture_output=True,
                             text=True, timeout=10).stdout.strip()
    except Exception:  # noqa: BLE001
        return
    if cur in ("main", "master"):
        block(f"you're on {cur}: never commit there. Switch to your ap/… branch first")


def team_bash(cmd: str) -> None:
    """Team mode: only your own ap/<login>/ branches."""
    if not ME:
        return
    for m in re.finditer(r"\bgit\s+push\b[^\n;&|]*", cmd):
        for ref in re.findall(r"\bap/([\w-]+)/", m.group(0)):
            if ref != ME:
                block(f"ap/{ref}/ belongs to @{ref}'s autopilot; push only ap/{ME}/…")


def strip_quoted(cmd: str) -> str:
    """Blank out quoted prose and heredoc bodies (PR/issue comment text)."""
    cmd = re.sub(r"<<-?\s*['\"]?(\w+)['\"]?.*?\n.*?^\1$", "<<HEREDOC", cmd, flags=re.S | re.M)
    # Only prose (quoted text with whitespace) is blanked; a quoted single word like "main"
    # stays visible, so quoting can't be used to slip a ref past the rules.
    cmd = re.sub(r"'[^']*\s[^']*'", "''", cmd)
    return re.sub(r'"(?:\\.|[^"\\])*\s(?:\\.|[^"\\])*"', '""', cmd)


def block(msg: str) -> None:
    print(f"BLOCKED by autopilot guard: {msg}", file=sys.stderr)
    sys.exit(2)


def check_write(tool: str, inp: dict, root: str, data: dict) -> None:
    path = inp.get("file_path") or inp.get("notebook_path") or ""
    real = os.path.realpath(os.path.join(root, path))
    scratch = data.get("scratchpad_dir") or ""
    inside = real == root or real.startswith(root + os.sep)
    if not inside and not (scratch and real.startswith(os.path.realpath(scratch) + os.sep)):
        block(f"write outside project: {path}")
    rel = os.path.relpath(real, root)
    # Worktrees mirror the repo under .claude/worktrees/<name>/: apply the same rules there.
    m = re.match(r"\.claude/worktrees/[^/]+/(.*)", rel)
    if m:
        rel = m.group(1)
    if any(rel == p.rstrip("/") or rel.startswith(p) for p in PROTECTED):
        block(f"protected or human-owned path: {rel} (ask the human via DECISIONS.md)")
    if rel.startswith(TEAM_DIR) and not rel.startswith(OWN_DIR):
        block(f"{rel} is another person's autopilot state; yours is {OWN_DIR}")
    if rel.endswith("TASK.md") and rel.startswith(OWN_DIR):
        block("TASK.md is written by the supervisor from the issue; don't edit it")
    if rel in APPEND_ONLY:
        old = open(real, encoding="utf-8").read() if os.path.exists(real) else ""
        if tool == "Write" and not (inp.get("content") or "").startswith(old):
            block(f"{rel} is append-only: Write must keep the existing content as a prefix")
        if tool == "Edit":
            o, n = inp.get("old_string", ""), inp.get("new_string", "")
            if inp.get("replace_all") or not n.startswith(o) or not old.rstrip().endswith(o.rstrip()):
                block(f"{rel} is append-only: Edit must anchor on the file's last lines and only add after them")


def main() -> None:
    data = json.load(sys.stdin)
    tool = data.get("tool_name", "")
    inp = data.get("tool_input") or {}
    root = os.path.realpath(os.environ.get("CLAUDE_PROJECT_DIR") or data.get("cwd") or ".")
    if tool in ("Edit", "Write", "NotebookEdit"):
        check_write(tool, inp, root, data)
    elif tool == "Bash":
        cmd = inp.get("command", "")
        bare = strip_quoted(cmd)
        for pat, why in BASH_RULES.items():
            # File-write rules look at the raw command (a quoted path is still a path); command
            # rules ignore quoted text, so a PR comment that *mentions* `git push main` passes.
            if re.search(pat, cmd if "protected file" in why or "append-only" in why else bare):
                block(f"{why}: {cmd[:200]}")
        team_bash(bare)
        branch_rules(bare, root)
    sys.exit(0)


if __name__ == "__main__":
    main()
