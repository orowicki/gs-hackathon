"""Check the environment before spending anything. Every check maps to a v1 failure.

    python -m autopilot.doctor [--fix-trust] [--online]

Prints PASS / WARN / FAIL with a fix for each. Exit 1 if any FAIL.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request

from . import config as cfgmod
from . import ledger

IN_CONTAINER = cfgmod.in_container()
results: list[tuple[str, str, str, str]] = []


def check(name: str, level: str, detail: str = "", fix: str = "") -> None:
    results.append((level, name, detail, fix))


def sh(*cmd, cwd=None, timeout=20) -> tuple[int, str]:
    try:
        r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout)
        return r.returncode, (r.stdout + r.stderr).strip()
    except (OSError, subprocess.TimeoutExpired) as e:
        return 127, str(e)


def reachable(url: str, timeout: float = 6) -> bool:
    try:
        urllib.request.urlopen(urllib.request.Request(url, method="HEAD"), timeout=timeout)
        return True
    except urllib.error.HTTPError:
        return True  # got an HTTP answer -> network path works
    except Exception:  # noqa: BLE001
        return False


def vtuple(v: str) -> tuple:
    return tuple(int(x) for x in re.findall(r"\d+", v)[:3])


def claude_config_file() -> str:
    d = os.environ.get("CLAUDE_CONFIG_DIR")
    return os.path.join(d, ".claude.json") if d else os.path.expanduser("~/.claude.json")


def run(cfg, fix_trust: bool, online: bool) -> int:
    root = cfg.root
    # 1. claude binary + version
    code, out = sh("claude", "--version")
    if code != 0:
        check("claude installed", "FAIL", out[:100], "npm install -g @anthropic-ai/claude-code")
    else:
        v = out.split()[0]
        lvl = "PASS" if vtuple(v) == vtuple(cfg.tested_claude_version) else "WARN"
        check("claude version", lvl, f"{v} (kit tested on {cfg.tested_claude_version})",
              "" if lvl == "PASS" else "stream events (task_*) are undocumented; run `just replay` on a short log to confirm the view still works")

    # 2. auth (v1 run 1: 'Not logged in')
    cdir = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")
    has_key = bool(os.environ.get("ANTHROPIC_API_KEY"))
    has_token = bool(os.environ.get("CLAUDE_CODE_OAUTH_TOKEN"))
    has_login = os.path.exists(os.path.join(cdir, ".credentials.json")) or sys.platform == "darwin"
    check("claude auth", "PASS" if (has_key or has_token or has_login) else "FAIL",
          "API key in env (billed per call)" if has_key else "OAuth token in env" if has_token
          else ("login found" if has_login else "no key, no login"),
          "run `claude` once and /login (persists in the claude-config volume), or set ANTHROPIC_API_KEY in the env-file")
    if os.path.isdir(cdir) and not os.access(cdir, os.W_OK):
        check("claude config writable", "FAIL", cdir, "volume is root-owned: rebuild with the kit Dockerfile (pre-created dirs)")

    # 3. folder trust (v1: allow rules ignored until trusted)
    cf = claude_config_file()
    trusted = False
    try:
        data = json.load(open(cf))
        trusted = bool(data.get("projects", {}).get(root, {}).get("hasTrustDialogAccepted"))
        if not trusted and fix_trust:
            data.setdefault("projects", {}).setdefault(root, {})["hasTrustDialogAccepted"] = True
            json.dump(data, open(cf, "w"), indent=2)
            trusted = True
    except (OSError, ValueError):
        pass
    check("folder trust", "PASS" if trusted else "WARN", root,
          "run `claude` once in this folder and accept trust, or `just doctor --fix-trust`")

    # 4. container: firewall, sandbox, volumes (v1: bwrap, root-owned volumes, CDN misses)
    if IN_CONTAINER:
        if os.path.exists("/run/.containerenv") and not os.path.exists("/.dockerenv"):
            check("container engine", "FAIL", "Podman",
                  "Podman isn't supported (its networking bypasses the firewall setup): see the kit README, Troubleshooting: Podman")
        ok = os.access(root, os.R_OK | os.W_OK)
        check("workspace readable", "PASS" if ok else "FAIL", root,
              "on SELinux hosts (Fedora) the bind mount needs relabelling: report it, see docs/TEAMMATES.md")
        blocked = not reachable("https://example.com", 5)
        check("egress firewall blocks", "PASS" if blocked else "FAIL", "example.com",
              "sudo /usr/local/bin/init-firewall.sh")
        check("anthropic reachable", "PASS" if reachable("https://api.anthropic.com") else "FAIL",
              "api.anthropic.com", "check DNS / firewall logs")
        allow = os.path.join(root, ".devcontainer", "allowlist.txt")
        if online and os.path.exists(allow):
            for line in open(allow):
                d = line.split("#", 1)[0].strip()
                if d:
                    ok = reachable(f"https://{d}")
                    check(f"allowlist {d}", "PASS" if ok else "FAIL", "",
                          "domain unresolvable or blocked; CDNs often redirect to other hosts: add them")
        for d in ("~/.venv", "~/.cache/uv", "~/.claude"):
            p = os.path.expanduser(d)
            ok = os.path.isdir(p) and os.access(p, os.W_OK)
            check(f"writable {d}", "PASS" if ok else "FAIL", "", "rebuild the container with the kit Dockerfile")
        check("nested sandbox", "PASS", "disabled per-run by the supervisor (bubblewrap can't run under Docker seccomp); container + firewall is the boundary")
    else:
        check("container", "WARN", "running on the host",
              "unattended runs belong in the devcontainer (firewall + non-root); host runs keep Claude's own sandbox on")

    # 5. uv venv outside the repo (v1: reinstall on every rebuild)
    venv = os.environ.get("UV_PROJECT_ENVIRONMENT", "")
    check("venv location", "PASS" if venv and not venv.startswith(root) else "WARN", venv or "(unset: .venv in repo)",
          "set UV_PROJECT_ENVIRONMENT to a path in $HOME (the kit container does)")

    # 6. timezone (v1: UTC vs local)
    tz = os.environ.get("TZ", "")
    check("timezone", "PASS" if tz and tz not in ("UTC", "Etc/UTC") else "WARN", tz or "(unset)",
          "host-prep.sh passes the host TZ; check .devcontainer/.host.env")

    # 7. secrets: required keys non-empty, no env file in the repo (v1: keys passed empty)
    for var in cfg.required_env:
        check(f"env {var}", "PASS" if os.environ.get(var) else "FAIL", "set" if os.environ.get(var) else "empty",
              f"add {var}=... to ~/.config/autopilot/{os.path.basename(root)}.env and rebuild/restart")
    code, tracked = sh("git", "ls-files", ".env", "*.env", cwd=root)
    check("no env files tracked", "PASS" if not tracked else "FAIL", tracked[:80], "git rm --cached them; keep keys outside the repo")
    ntfy = os.environ.get(cfg.ntfy_env, "")
    check("ntfy webhook", "PASS" if ntfy else "WARN", "set" if ntfy else "unset",
          f"set {cfg.ntfy_env}=https://ntfy.sh/<long-random-topic> in the env-file for phone/desktop alerts")

    # 8. git identity + branch (v1: agent identity, ran on long-lived branch)
    _, name = sh("git", "config", "--get", "user.name", cwd=root)
    name = os.environ.get("GIT_AUTHOR_NAME") or name
    bad = (not name) or "claude" in name.lower() or "autopilot" in name.lower()
    check("git identity", "FAIL" if bad else "PASS", name or "(none)",
          "commits must use the human's identity: set git user.name/email on the host (host-prep passes it in)")
    _, branch = sh("git", "branch", "--show-current", cwd=root)
    if cfg.team_enabled:
        check("branch", "PASS", f"{branch or '(detached)'} (team mode: the autopilot works in .autopilot/work, any branch is fine)")
    else:
        check("branch", "FAIL" if branch in ("main", "master", "") else "PASS", branch or "(detached)",
              "solo mode works in your checkout: git switch -c ap/run")
    code, _ = sh("git", "remote", "get-url", "origin", cwd=root)
    if code == 0:
        _, url = sh("git", "remote", "get-url", "origin", cwd=root)
        m = re.search(r"github\.com[:/]([^/]+/[^/.]+)", url)
        if m and shutil.which("gh"):
            repo = m.group(1)
            code, out = sh("gh", "api", f"repos/{repo}", "--jq", ".permissions.push", timeout=20)
            check("GitHub token sees repo", "PASS" if code == 0 and out.strip() == "true" else "FAIL",
                  repo if code == 0 else out[:100],
                  "set GH_TOKEN (fine-grained: this repo only; Contents + Pull requests read/write) in the env-file, restart the container")
            code, out = sh("git", "ls-remote", "--heads", "origin", cwd=root, timeout=30)
            check("git push auth", "PASS" if code == 0 else "FAIL", "" if code == 0 else out[:100],
                  "with GH_TOKEN set, run `gh auth setup-git` (postStart does it)")
        elif m:
            check("gh", "WARN", "not installed", "the agent will record 'ready to push' instead of opening PRs")

    # 8b. team mode (v3)
    if cfg.team_enabled:
        from . import team
        repo = cfg.team_repo or team.repo_from_remote(root)
        if not repo:
            check("team repo", "FAIL", "no GitHub origin", "add the GitHub remote or set [team] repo")
        elif not shutil.which("gh"):
            check("team gh", "FAIL", "gh not installed", "the kit container has gh; run doctor there")
        else:
            gh = team.GitHub(repo)
            try:
                me = team.whoami(gh)
                check("team login", "PASS", f"@{me}; state in .autopilot/work/results/autopilot/team/{me}/ (local)")
            except Exception as e:  # noqa: BLE001
                check("team login", "FAIL", str(e)[:90], "GH_TOKEN must be set in the env-file")
            try:
                have = {lbl["name"] for lbl in gh.api("GET", gh.r("labels?per_page=100")) or []}
                missing = sorted(set(team.LABELS) - have)
                check("team labels", "PASS" if not missing else "FAIL", ", ".join(missing) or "all present",
                      "just team init")
                gh.issues("ap:task")
                check("team issues readable", "PASS", repo)
            except Exception as e:  # noqa: BLE001
                check("team issues", "FAIL", str(e)[:90],
                      "token needs Issues: Read and write on this repo")
            if cfg.values.get("team_auto_merge"):
                try:
                    sha = gh.api("GET", gh.r("commits/main"))["sha"]
                    team.checks_state(gh, sha)
                    check("auto-merge checks", "PASS", "token can read CI results")
                except Exception as e:  # noqa: BLE001
                    check("auto-merge checks", "WARN", "token can't read CI results: every PR will wait for a person",
                          "give GH_TOKEN Actions: Read, and Commit statuses: Read if you use other CI (then recreate the container: ap setup)")
            name = cfg.values.get("team_discussions", "")
            if name:
                try:
                    ok = team.note_category(gh, name) is not None
                    check("team notes", "PASS" if ok else "WARN",
                          f"Discussions category \"{name}\"" + ("" if ok else " not found: notes are off"),
                          f"repo Settings → Features → Discussions, then add a category named {name} "
                          "(or set [team] discussions = \"\")")
                except Exception as e:  # noqa: BLE001
                    check("team notes", "WARN", str(e)[:90], "token needs Discussions: Read and write")

    # 9. SPEC + budget (v1: grep TODO false positive)
    check("SPEC ready", "PASS" if cfg.spec_ready else "FAIL", f"profile={cfg.profile}",
          "fill docs/autopilot/SPEC.md and set `ready: true` in its frontmatter")
    spent = ledger.total(cfg.ledger_path)
    left = cfg.budget_usd - spent
    check("budget", "PASS" if left >= cfg.min_segment_usd else "FAIL",
          f"spent ${spent:.2f} of ${cfg.budget_usd:.2f}", "raise budget_usd in SPEC frontmatter")

    # 10. plugin + hooks
    pdir = os.path.join(root, cfg.plugin_dir)
    if os.path.isdir(pdir):
        code, out = sh("claude", "plugin", "validate", pdir, timeout=60)
        check("plugin valid", "PASS" if code == 0 else "WARN", out.splitlines()[-1][:100] if out else "", "see `claude plugin validate`")
        guard = os.path.join(pdir, "hooks", "guard.py")
        r = subprocess.run([sys.executable, "-I", guard], input=json.dumps(
            {"tool_name": "Bash", "tool_input": {"command": "git push --force origin main"}}),
            capture_output=True, text=True, env={**os.environ, "CLAUDE_PROJECT_DIR": root})
        check("guard hook blocks", "PASS" if r.returncode == 2 else "FAIL", "", "python3 missing or guard broken")
    else:
        check("plugin dir", "FAIL", cfg.plugin_dir, "re-run autopilot-init")

    # 11. gate commands exist
    if shutil.which("just"):
        _, recipes = sh("just", "--summary", cwd=root)
        for cmd in [c.strip() for c in cfg.gate.split(";;") if c.strip()]:
            parts = cmd.split()
            if parts[0] == "just" and len(parts) > 1:
                check(f"gate `{cmd}`", "PASS" if parts[1] in recipes.split() else "FAIL", "",
                      f"add a `{parts[1]}` recipe to the justfile")
    else:
        check("just", "FAIL", "", "install just (the kit container has it)")

    # report
    icon = {"PASS": "✔", "WARN": "!", "FAIL": "✖"}
    for lvl, name, detail, fix in results:
        line = f"{icon[lvl]} {lvl:4} {name}" + (f": {detail}" if detail else "")
        print(line)
        if lvl != "PASS" and fix:
            print(f"         fix: {fix}")
    fails = sum(1 for r in results if r[0] == "FAIL")
    warns = sum(1 for r in results if r[0] == "WARN")
    print(f"\n{len(results) - fails - warns} pass, {warns} warn, {fails} fail")
    return 1 if fails else 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--fix-trust", action="store_true", help="mark this folder as trusted in the claude config")
    ap.add_argument("--online", action="store_true", help="also probe every allowlisted domain")
    ap.add_argument("--root", default=None)
    a = ap.parse_args(argv)
    root = a.root or sh("git", "rev-parse", "--show-toplevel")[1] or os.getcwd()
    return run(cfgmod.load(root), a.fix_trust, a.online)


if __name__ == "__main__":
    sys.exit(main())
