"""Live view of a stream-json run: pinned status bar, folded subagent work, end banner.

Uses `rich` when available, plain lines otherwise. No model calls.
Replay an old log:  python -m autopilot.view <log.jsonl> [--fast]
"""

from __future__ import annotations

import json
import re
import sys
import time
from datetime import datetime

from .events import RunState

try:
    from rich.console import Console, Group
    from rich.live import Live
    from rich.panel import Panel
    from rich.table import Table
    from rich.text import Text

    HAVE_RICH = True
except ImportError:  # pragma: no cover - plain fallback
    HAVE_RICH = False

AGENT_TOOLS = {"Agent", "Task"}
MODEL_SHORT = {"opus": "O", "sonnet": "S", "haiku": "H"}


def short(s, n: int) -> str:
    s = re.sub(r"\s+", " ", str(s or "")).strip()
    return s if len(s) <= n else s[: n - 1] + "…"


def tool_arg(inp: dict) -> str:
    for k in ("description", "command", "file_path", "url", "query", "pattern", "skill"):
        if inp.get(k):
            return str(inp[k])
    return ""


class View:
    def __init__(self, state: RunState, *, label: str = "", budget: float | None = None,
                 spent_before: float = 0.0, out=None):
        self.s = state
        self.label = label
        self.budget = budget
        self.spent_before = spent_before
        self.started = time.time()
        self.milestone = ""
        self.console = Console(file=out, highlight=False) if HAVE_RICH else None
        self.live = None

    # ---- lifecycle -----------------------------------------------------
    def __enter__(self):
        if HAVE_RICH and self.console.is_terminal:
            self.live = Live(self._bar(), console=self.console, refresh_per_second=2, transient=True)
            self.live.__enter__()
        return self

    def __exit__(self, *exc):
        if self.live:
            self.live.__exit__(*exc)

    def refresh(self) -> None:
        if self.live:
            self.live.update(self._bar())

    # ---- events --------------------------------------------------------
    def on_event(self, ev: dict) -> None:
        for line, style in self._lines(ev):
            self._print(line, style)
        self.refresh()

    def _print(self, line: str, style: str = "") -> None:
        ts = datetime.now().strftime("%H:%M:%S")
        if self.console:
            self.console.print(Text(f"{ts} ", style="dim") + Text(line, style=style))
        else:
            print(f"{ts} {line}", flush=True)

    def _lines(self, ev: dict):
        typ, sub = ev.get("type"), ev.get("subtype")
        if typ == "assistant" and ev.get("parent_tool_use_id") is None:
            for b in (ev.get("message") or {}).get("content") or []:
                if b.get("type") == "text" and b.get("text", "").strip():
                    m = re.search(r"\bM\d+(\.\w+)?\b", b["text"])
                    if m:
                        self.milestone = m.group(0).split(".")[0]
                    yield "says     " + short(b["text"], 500), "bold"
                elif b.get("type") == "tool_use":
                    inp = b.get("input") or {}
                    if b.get("name") in AGENT_TOOLS:
                        yield (f"agent    {inp.get('subagent_type') or 'agent'}: {short(inp.get('description'), 90)}",
                               "magenta")
                    else:
                        yield f"tool     {b.get('name')} {short(tool_arg(inp), 110)}", "cyan"
        elif typ == "system" and sub == "task_notification":
            t = self.s.tasks.get(ev.get("task_id", ""))
            if t and t.kind == "local_agent":
                st = ev.get("status")
                style = "green" if st == "completed" else "red"
                yield f"   ↳ {t.agent} {st}: {short(t.description, 70)} ({t.tokens // 1000}k tok)", style
        elif typ == "system" and sub == "permission_denied":
            yield f"refused  {ev.get('tool_name')}: {short(ev.get('message'), 120)}", "yellow"
        elif typ == "system" and sub == "api_retry":
            yield f"↻ API retry: {short(ev.get('error') or ev, 100)}", "yellow"
        elif typ == "result" and ev.get("is_error"):
            yield f"error    {ev.get('terminal_reason') or ev.get('subtype')}: {short(ev.get('result'), 200)}", "bold red"

    # ---- rendering -----------------------------------------------------
    def cost_line(self) -> str:
        spent = self.spent_before + self.s.cost
        parts = " ".join(
            f"{MODEL_SHORT.get(next((k for k in MODEL_SHORT if k in m), m), m)}${c:.2f}"
            for m, c in sorted(self.s.cost_by_model.items())
        )
        cap = f"/${self.budget:.2f}" if self.budget else ""
        return f"${spent:.2f}{cap} (segment ${self.s.cost:.2f} {parts})".strip()

    def _bar(self):
        el = int(time.time() - self.started)
        head = (f"{self.label}  {self.milestone or '—'}  {el // 3600}:{el // 60 % 60:02d}:{el % 60:02d}  "
                f"spent {self.cost_line()} · agents {len(self.s.live_agents)} running, {self.s.agents_spawned} total")
        if not HAVE_RICH:
            return head
        tbl = Table.grid(padding=(0, 1))
        for t in self.s.live_tasks:
            icon = "agent" if t.kind == "local_agent" else "task"
            tbl.add_row(icon, Text(t.agent, style="magenta"), short(t.description, 50),
                        Text(short(t.last_activity, 50), style="dim"), f"{t.tokens // 1000}k")
        return Panel(Group(Text(head, style="bold"), tbl) if self.s.live_tasks else Text(head, style="bold"),
                     border_style="blue")

    def banner(self, status: str, questions: list[str], extra: str = "", totals: dict | None = None) -> None:
        """The end-of-run summary, in the words of voice.py."""
        from . import voice
        code, _, reason = (status or "").partition(" ")
        word = voice.word(code) if code in voice.STATUS_WORDS else (status or "")
        reason = reason.strip()
        if reason.startswith("(") and reason.endswith(")"):
            reason = reason[1:-1]
        head = f"{word}: {reason}" if reason and code in voice.STATUS_WORDS else word
        if totals:
            cap = f" of ${self.budget:.2f}" if self.budget else ""
            body = [f"Spent ${self.spent_before:.2f}{cap} over {totals['segments']} run(s) · "
                    f"{totals['agents']} agent(s), {totals['lost']} lost"]
        else:
            body = [f"Spent {self.cost_line()} · {self.s.agents_spawned} agent(s)"]
        if self.s.lost_agents:
            body.append("Lost agents (stopped before they finished): " + ", ".join(t.description for t in self.s.lost_agents))
        if extra:
            body.append(extra)
        if questions:
            body.append("\nQuestions for you:")
            for q in questions:
                title, _, default = q.partition("  [default: ")
                line = f"  - {title.split('·')[-1].strip()}"
                body.append(line + (f" (default: {default.rstrip(']').strip()[:70]})" if default else ""))
            body.append("\nAnswer with: just decide")
        if self.console:
            # Text, not a markup string: titles like "[default: A]" must not be parsed as style tags.
            style = voice.STYLE.get(word, "bold")
            text = Text.assemble((head, style), "\n" + "\n".join(body))
            self.console.print(Panel(text, title="autopilot", border_style=style.split()[-1]))
        else:
            print("\n".join(["=" * 60, head, *body, "=" * 60]))


def replay(path: str, fast: bool = True) -> RunState:
    s = RunState()
    with View(s, label=path.rsplit("/", 1)[-1]) as v:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                try:
                    ev = json.loads(line)
                except json.JSONDecodeError:
                    continue
                s.feed(ev)
                v.on_event(ev)
                if not fast:
                    time.sleep(0.02)
    v.banner("(replay)", [])
    return s


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("usage: python -m autopilot.view <log.jsonl> [--slow]")
    replay(sys.argv[1], fast="--slow" not in sys.argv)
