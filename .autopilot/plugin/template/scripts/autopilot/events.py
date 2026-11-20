"""Parse Claude Code stream-json into run state. Stdlib only, no model calls.

Facts this relies on (observed in v1 logs, Claude Code 2.1.325-326):
- `result.total_cost_usd` is CUMULATIVE per session_id. A headless process emits a
  new `result` each time a background task wakes the coordinator, so per-run cost
  is the max per session, never the sum (summing v1 logs gave $842 vs $83.69).
- `result.modelUsage[model].costUSD` is cumulative per model, same rule.
- `system/background_tasks_changed.tasks` is the full list of live background tasks.
- `result` events are flushed in a batch at process exit, so their order says
  nothing about timing. Tasks still running at exit get `task_updated` status
  `killed` (then `task_notification` `stopped`): that is the lost-work signal.
- `system/task_started|task_progress|task_notification|task_updated` describe tasks;
  `task_type` is `local_agent` (subagent) or `local_bash` (background shell).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Iterable

TERMINAL_TASK = {"completed", "failed", "stopped", "killed"}


@dataclass
class Task:
    task_id: str
    kind: str  # local_agent | local_bash | ...
    agent: str  # subagent_type or "bash"
    description: str
    status: str = "running"
    tokens: int = 0
    tool_uses: int = 0
    last_activity: str = ""


@dataclass
class RunState:
    session_cost: dict[str, float] = field(default_factory=dict)
    session_models: dict[str, dict[str, float]] = field(default_factory=dict)
    tasks: dict[str, Task] = field(default_factory=dict)
    live_ids: set[str] = field(default_factory=set)
    results: int = 0
    turns: int = 0
    last_result_text: str = ""
    last_text: str = ""
    terminal_reason: str | None = None
    result_subtype: str | None = None
    errors: list[str] = field(default_factory=list)
    is_error: bool = False
    permission_denials: int = 0
    first_ts: str | None = None
    last_ts: str | None = None

    # ---- derived -------------------------------------------------------
    @property
    def cost(self) -> float:
        return sum(self.session_cost.values())

    @property
    def cost_by_model(self) -> dict[str, float]:
        out: dict[str, float] = {}
        for models in self.session_models.values():
            for m, c in models.items():
                out[m] = out.get(m, 0.0) + c
        return out

    @property
    def live_tasks(self) -> list[Task]:
        return [self.tasks[t] for t in self.live_ids if t in self.tasks]

    @property
    def live_agents(self) -> list[Task]:
        return [t for t in self.live_tasks if t.kind == "local_agent"]

    @property
    def budget_exhausted(self) -> bool:
        """Observed on 2.1.327: subtype=error_max_budget_usd, terminal_reason=budget_exhausted,
        errors=["Reached maximum budget ($X)"]. Accept any of the three."""
        return (self.result_subtype == "error_max_budget_usd"
                or self.terminal_reason in ("budget_exhausted", "error_max_budget_usd")
                or any("maximum budget" in e for e in self.errors))

    @property
    def killed(self) -> list[Task]:
        """Tasks the harness killed (v1: only happened when the process exited
        while they ran, i.e. lost work)."""
        return [t for t in self.tasks.values() if t.status == "killed"]

    @property
    def lost_agents(self) -> list[Task]:
        return [t for t in self.killed if t.kind == "local_agent"]

    @property
    def agents_spawned(self) -> int:
        return sum(1 for t in self.tasks.values() if t.kind == "local_agent")

    # ---- ingestion -----------------------------------------------------
    def feed(self, ev: dict) -> None:
        ts = ev.get("timestamp")
        if ts:
            self.first_ts = self.first_ts or ts
            self.last_ts = ts
        typ, sub = ev.get("type"), ev.get("subtype")
        if typ == "result":
            self._on_result(ev)
        elif typ == "assistant" and ev.get("parent_tool_use_id") is None:
            for block in (ev.get("message") or {}).get("content") or []:
                if block.get("type") == "text" and block.get("text", "").strip():
                    self.last_text = block["text"]
        elif typ == "system":
            if sub == "task_started":
                tid = ev.get("task_id", "")
                self.tasks[tid] = Task(
                    task_id=tid,
                    kind=ev.get("task_type") or "unknown",
                    agent=ev.get("subagent_type") or "bash",
                    description=ev.get("description") or "",
                )
                self.live_ids.add(tid)
            elif sub == "task_progress":
                t = self.tasks.get(ev.get("task_id", ""))
                if t:
                    u = ev.get("usage") or {}
                    t.tokens = u.get("total_tokens", t.tokens)
                    t.tool_uses = u.get("tool_uses", t.tool_uses)
                    t.last_activity = ev.get("description") or t.last_activity
            elif sub in ("task_notification", "task_updated"):
                tid = ev.get("task_id", "")
                status = ev.get("status") or (ev.get("patch") or {}).get("status")
                t = self.tasks.get(tid)
                if t and status and t.status != "killed":
                    t.status = status
                    u = ev.get("usage") or {}
                    t.tokens = u.get("total_tokens", t.tokens)
                if status in TERMINAL_TASK:
                    self.live_ids.discard(tid)
            elif sub == "background_tasks_changed":
                self.live_ids = {t.get("task_id") for t in ev.get("tasks") or []}
                for t in ev.get("tasks") or []:
                    tid = t.get("task_id")
                    if tid not in self.tasks:
                        self.tasks[tid] = Task(
                            tid, t.get("task_type") or "unknown",
                            t.get("subagent_type") or "bash", t.get("description") or "",
                        )
            elif sub == "permission_denied":
                self.permission_denials += 1

    def _on_result(self, ev: dict) -> None:
        sid = ev.get("session_id") or "?"
        cost = float(ev.get("total_cost_usd") or 0.0)
        if cost >= self.session_cost.get(sid, 0.0):
            self.session_cost[sid] = cost
            self.session_models[sid] = {
                m: float((u or {}).get("costUSD") or 0.0)
                for m, u in (ev.get("modelUsage") or {}).items()
            }
        self.results += 1
        self.turns += int(ev.get("num_turns") or 0)
        self.last_result_text = ev.get("result") or self.last_result_text
        self.terminal_reason = ev.get("terminal_reason") or self.terminal_reason
        self.result_subtype = ev.get("subtype") or self.result_subtype
        self.errors += [str(e) for e in ev.get("errors") or []]
        self.is_error = bool(ev.get("is_error"))


def parse_lines(lines: Iterable[str], state: RunState | None = None) -> RunState:
    state = state or RunState()
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            state.feed(json.loads(line))
        except json.JSONDecodeError:
            continue
    return state


def parse_file(path: str) -> RunState:
    with open(path, encoding="utf-8") as fh:
        return parse_lines(fh)
