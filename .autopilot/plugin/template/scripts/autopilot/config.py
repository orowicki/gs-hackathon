"""Kit configuration: autopilot.toml (repo root) + SPEC.md frontmatter."""

from __future__ import annotations

import os
import re
import tomllib
from dataclasses import dataclass, field

DEFAULTS = {
    "budget_usd": 10.0,
    "min_segment_usd": 0.5,
    "budget_margin_usd": 0.5,
    "max_turns": 400,
    "model": "opus",
    "idle_timeout_min": 20,
    "silent_timeout_min": 60,
    "unknown_segment_usd": 1.0,
    "exit_grace_s": 120,
    "max_no_progress": 2,
    "backoff_s": [10, 60, 300],
    "bg_wait_ceiling_ms": 1_800_000,
    "plugin_dir": ".autopilot/plugin",
    "gate": "just lint;;just test",
    "desktop_notify": True,
    "ntfy_env": "AUTOPILOT_NTFY_URL",
    "name": "",
    "notify_done": False,  # [notify] also send a phone notification when a run finishes
    "required_env": [],
    "tested_claude_version": "2.1.327",
    # [team] (keys are prefixed team_ after loading)
    "team_enabled": False,
    "team_repo": "",
    "team_poll_minutes": 5,
    "team_max_open_claims": 1,
    "team_claim_expiry_h": 24,
    "team_heartbeat_minutes": 20,
    "team_max_proposals": 5,
    "team_login": "",
    "team_discussions": "Autopilot",  # Discussions category for team notes ("" = off)
    "team_max_notes": 3,               # notes an autopilot may post per run
    "team_auto_merge": None,           # None = on with the hackathon profile only
    "team_auto_merge_delay_min": 5,
    "team_auto_promote": None,         # None = on with the hackathon profile only
    "team_auto_promote_delay_min": 10,
}


@dataclass
class Config:
    root: str
    values: dict = field(default_factory=dict)

    def __getattr__(self, k):
        try:
            return self.values[k]
        except KeyError as e:
            raise AttributeError(k) from e

    @property
    def shared_dir(self) -> str:
        """SPEC.md and NOTES-HUMAN.md: shared by everyone, human-owned."""
        return os.path.join(self.root, "docs", "autopilot")

    @property
    def team(self) -> bool:
        return bool(self.values.get("team_enabled") and self.values.get("team_login"))

    @property
    def work_dir(self) -> str:
        """Where the agent works. Team mode: its own git worktree, so the human's checkout is
        never switched or edited under them (dry run 8)."""
        return os.path.join(self.root, ".autopilot", "work") if self.team else self.root

    @property
    def state_rel(self) -> str:
        """Relative to work_dir. Team mode: local, uncommitted, per person: GitHub holds the
        shared truth, and branch switches can't split or lose the notes (dry run 8)."""
        return f"results/autopilot/team/{self.values['team_login']}" if self.team else "docs/autopilot"

    @property
    def state_dir(self) -> str:
        return os.path.join(self.work_dir, self.state_rel)

    @property
    def results_dir(self) -> str:
        return os.path.join(self.root, "results", "autopilot")

    @property
    def ledger_path(self) -> str:
        return os.path.join(self.results_dir, "ledger.jsonl")


def spec_frontmatter(path: str) -> dict:
    if not os.path.exists(path):
        return {}
    text = open(path, encoding="utf-8").read()
    m = re.match(r"^---\n(.*?)\n---", text, re.S)
    if not m:
        return {}
    out = {}
    for line in m.group(1).splitlines():
        line = line.split("#", 1)[0].strip()
        if ":" in line:
            k, v = (x.strip() for x in line.split(":", 1))
            out[k] = {"true": True, "false": False}.get(v.lower(), v)
            try:
                out[k] = float(v)
            except ValueError:
                pass
    return out


def load(root: str) -> Config:
    vals = dict(DEFAULTS)
    toml_path = os.path.join(root, "autopilot.toml")
    if os.path.exists(toml_path):
        with open(toml_path, "rb") as fh:
            data = tomllib.load(fh)
        for name, section in data.items():
            if isinstance(section, dict):
                vals.update({f"team_{k}": v for k, v in section.items()} if name == "team" else section)
    fm = spec_frontmatter(os.path.join(root, "docs", "autopilot", "SPEC.md"))
    if "budget_usd" in fm:
        vals["budget_usd"] = float(fm["budget_usd"])
    vals["spec_ready"] = fm.get("ready") is True
    vals["profile"] = fm.get("profile", "core")
    if vals["profile"] == "hackathon" and "claim_expiry_h" not in (data.get("team", {}) if os.path.exists(toml_path) else {}):
        vals["team_claim_expiry_h"] = 2
    for k in ("team_auto_merge", "team_auto_promote"):
        if vals[k] is None:
            vals[k] = vals["profile"] == "hackathon"
    if vals["team_enabled"] and not vals["team_login"]:
        vals["team_login"] = cached_login(root)
    return Config(root=root, values=vals)


def login_cache(root: str) -> str:
    return os.path.join(root, "results", "autopilot", "team", "login")


def cached_login(root: str) -> str:
    """The GitHub login of the person running this autopilot (written by the supervisor)."""
    if os.environ.get("AUTOPILOT_LOGIN"):
        return os.environ["AUTOPILOT_LOGIN"]
    try:
        return open(login_cache(root)).read().strip()
    except OSError:
        return ""


def in_container() -> bool:
    """Docker creates /.dockerenv, Podman /run/.containerenv; the kit image also sets AUTOPILOT_CONTAINER=1."""
    return (os.environ.get("AUTOPILOT_CONTAINER") == "1"
            or os.path.exists("/.dockerenv") or os.path.exists("/run/.containerenv"))
