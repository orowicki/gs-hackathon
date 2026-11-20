"""Answer open autopilot decisions without editing files by hand. Deterministic, no model calls.

    python -m autopilot.decide [--list] [--no-resume]

For each unanswered entry in docs/autopilot/DECISIONS.md: shows context, options and the
recommended default; you type a letter, Enter (= recommended), free text, `s` (skip) or
`q` (quit). Writes answer / answered-by / status. When nothing is open and STATE says
WAITING, offers to set `STATUS: RESUME`.
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from datetime import date

try:
    from rich import box
    from rich.console import Console, Group
    from rich.markdown import Markdown
    from rich.panel import Panel
    from rich.rule import Rule
    from rich.table import Table
    from rich.text import Text

    console = Console(highlight=False)
except ImportError:  # plain fallback
    console = None

HEADER = re.compile(r"^## (D-\d+)\b.*$", re.M)
COMMENT = re.compile(r"<!--.*?-->", re.S)


@dataclass
class Decision:
    id: str
    title: str
    start: int  # offsets into the file text
    end: int
    body: str

    def field(self, name: str) -> str:
        m = re.search(rf"^{name}:[ \t]*(.*)$", self.body, re.M)
        return m.group(1).split("  #", 1)[0].strip() if m else ""

    @property
    def is_open(self) -> bool:
        return self.field("status").startswith("open") and not self.field("answer")

    @property
    def options(self) -> dict[str, str]:
        m = re.search(r"^options:[ \t]*\n((?:[ \t]+.*\n?)+)", self.body, re.M)
        if not m:
            return {}
        return {k.upper(): v.strip() for k, v in re.findall(r"^[ \t]+([A-Za-z])[.)][ \t]*(.+)$", m.group(1), re.M)}

    @property
    def recommended(self) -> str | None:
        m = re.match(r"([A-Za-z])\b", self.field("recommended"))
        return m.group(1).upper() if m and m.group(1).upper() in self.options else None


def parse(text: str) -> list[Decision]:
    """Find entries outside HTML comments; offsets refer to the original text."""
    masked = COMMENT.sub(lambda m: re.sub(r"[^\n]", " ", m.group(0)), text)
    heads = list(HEADER.finditer(masked))
    out = []
    for i, h in enumerate(heads):
        end = heads[i + 1].start() if i + 1 < len(heads) else len(text)
        # stop the block at a following comment start, so the template example isn't swallowed
        c = text.find("<!--", h.end(), end)
        end = c if c != -1 else end
        title = text[h.start():h.end()][3:].strip()
        out.append(Decision(h.group(1), title, h.start(), end, text[h.start():end]))
    return out


def set_field(body: str, name: str, value: str) -> str:
    pat = re.compile(rf"^{name}:.*$", re.M)
    line = f"{name}: {value}"
    if pat.search(body):
        return pat.sub(lambda _: line, body, count=1)
    return body.rstrip("\n") + f"\n{line}\n" + ("\n" if body.endswith("\n\n") else "")


def apply_answer(text: str, d: Decision, answer: str, who: str) -> str:
    body = set_field(d.body, "answer", answer)
    body = set_field(body, "answered-by", f"{who} {date.today().isoformat()}")
    body = set_field(body, "status", "answered")
    return text[:d.start] + body + text[d.end:]


def resolve(raw: str, d: Decision) -> str | None:
    """Map what the human typed to the answer text. None = skip."""
    raw = raw.strip()
    if raw.lower() == "s":
        return None
    if raw == "" and d.recommended:
        raw = d.recommended
    if len(raw) == 1 and raw.upper() in d.options:
        k = raw.upper()
        return f"{k} — {d.options[k]}"
    return raw or None


def git_name(root: str) -> str:
    r = subprocess.run(["git", "config", "--get", "user.name"], cwd=root, capture_output=True, text=True)
    return os.environ.get("GIT_AUTHOR_NAME") or r.stdout.strip() or "human"


def _plain(d: Decision) -> str:
    lines = [f"\n━━ {d.title}"]
    for k in ("context", "if-unanswered"):
        if d.field(k):
            lines.append(f"  {k}: {d.field(k)}")
    for k, v in d.options.items():
        star = "  ← recommended" if k == d.recommended else ""
        lines.append(f"   {k}. {v}{star}")
    if d.field("recommended"):
        lines.append(f"  recommended: {d.field('recommended')}")
    return "\n".join(lines)


def _split_title(d: Decision) -> tuple[str, str]:
    parts = [p.strip() for p in d.title.split("·")]
    return (parts[0], parts[-1]) if len(parts) > 1 else (d.id, d.title)


def render(d: Decision, pos: int = 0, total: int = 0):
    """A rich renderable for one decision (or plain text without rich)."""
    if console is None:
        return _plain(d)
    did, title = _split_title(d)
    parts = []
    if d.field("context"):
        parts.append(Markdown(d.field("context")))
    opts = d.options
    if opts:
        t = Table(box=box.SIMPLE_HEAD, show_header=False, expand=True, padding=(0, 1))
        t.add_column(width=3, no_wrap=True)
        t.add_column(ratio=1)
        for k, v in opts.items():
            rec = k == d.recommended
            key = Text(f" {k} ", style="bold black on green" if rec else "bold")
            body = Markdown(v + ("  \n*★ recommended*" if rec else ""))
            t.add_row(key, body)
        parts.append(t)
    rec_text = d.field("recommended")
    if rec_text:
        parts.append(Text.assemble(("Recommended: ", "green"), (rec_text, "")))
    if d.field("if-unanswered"):
        parts.append(Text.assemble(("If you skip it: ", "dim"), (d.field("if-unanswered"), "dim italic")))
    counter = f"  {pos} of {total}" if total else ""
    return Panel(Group(*parts), title=Text(f" {did} · {title} ", style="bold"),
                 subtitle=Text(counter.strip(), style="dim") if counter else None,
                 border_style="cyan", padding=(1, 2))


def out(x="") -> None:
    if console is None:
        print(x)
    else:
        console.print(x)


HELP = "[bold]letter[/] pick · [bold]Enter[/] recommended · [bold]text[/] own answer · [bold]s[/] skip · [bold]q[/] quit"


def set_resume(state_path: str) -> bool:
    lines = open(state_path, encoding="utf-8").read().splitlines()
    if not lines or not lines[0].startswith("STATUS: WAITING"):
        return False
    lines[0] = "STATUS: RESUME"
    open(state_path, "w", encoding="utf-8").write("\n".join(lines) + "\n")
    return True


def main(argv=None, inp=input) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--list", action="store_true", help="only list open decisions")
    ap.add_argument("--no-resume", action="store_true", help="don't offer to set STATUS: RESUME")
    ap.add_argument("--root", default=None)
    a = ap.parse_args(argv)
    root = a.root or subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True,
                                    text=True).stdout.strip() or os.getcwd()
    from . import config as cfgmod
    cfg = cfgmod.load(root)
    path = os.path.join(cfg.state_dir, "DECISIONS.md")
    state = os.path.join(cfg.state_dir, "STATE.md")
    if not os.path.exists(path):
        print(f"No {cfg.state_rel}/DECISIONS.md here.")
        return 1
    gh = None
    if cfg.team_enabled:
        from . import team
        repo = cfg.team_repo or team.repo_from_remote(root)
        gh = team.GitHub(repo) if repo else None

    open_ids = [d.id for d in parse(open(path, encoding="utf-8").read()) if d.is_open]
    if not open_ids:
        print("No open decisions.")
    elif a.list:
        ds = [d for d in parse(open(path, encoding="utf-8").read()) if d.is_open]
        for i, d in enumerate(ds, 1):
            out(render(d, i, len(ds)))
        return 0
    else:
        who = git_name(root)
        answered: list[tuple[str, str]] = []
        interactive = console is not None and console.is_terminal
        for i, did in enumerate(open_ids, 1):
            text = open(path, encoding="utf-8").read()  # re-read: offsets change after each write
            d = next(x for x in parse(text) if x.id == did)
            if interactive:
                console.clear()
            out(render(d, i, len(open_ids)))
            out(HELP if console else "letter / Enter = recommended / text / s = skip / q = quit")
            try:
                raw = inp("  your answer › ")
            except EOFError:
                raw = "q"
            if raw.strip().lower() == "q":
                break
            ans = resolve(raw, d)
            if ans is None:
                answered.append((d.id, "skipped"))
                continue
            open(path, "w", encoding="utf-8").write(apply_answer(text, d, ans, who))
            answered.append((d.id, ans))
            if gh is not None and d.field(team.QFIELD):
                try:
                    team.post_answer(gh, d.field(team.QFIELD), ans)
                except Exception as e:  # noqa: BLE001 - the local answer already counts
                    out(f"(couldn't post the answer to {d.field('issue')}: {str(e)[:80]})")
        if answered:
            if interactive:
                console.clear()
            if console:
                t = Table(box=box.SIMPLE_HEAD, title="Your answers", title_style="bold", expand=True)
                t.add_column("id", no_wrap=True)
                t.add_column("answer")
                for did, ans in answered:
                    t.add_row(did, Text(ans, style="dim" if ans == "skipped" else "green"))
                out(t)
            else:
                for did, ans in answered:
                    print(f"  {did}: {ans}")

    still = [d.id for d in parse(open(path, encoding="utf-8").read()) if d.is_open]
    if still:
        out(f"\nStill open: {', '.join(still)}. The autopilot works around them where it can.")
    first = open(state, encoding="utf-8").readline().strip() if os.path.exists(state) else ""
    if first.startswith("STATUS: WAITING") and not a.no_resume:
        try:
            yes = inp(f"\nSTATE says '{first}'. Set it to RESUME so `just autopilot` continues? [Y/n] ")
        except EOFError:
            yes = "n"
        if yes.strip().lower() in ("", "y", "yes") and set_resume(state):
            out("✔ STATE set to RESUME. Run: just autopilot")
    elif first.startswith("STATUS: RESUME"):
        out("STATE says RESUME. Run: just autopilot")
    return 0


if __name__ == "__main__":
    sys.exit(main())
