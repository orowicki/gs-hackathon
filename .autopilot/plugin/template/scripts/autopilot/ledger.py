"""Append-only spend ledger. One line per segment (= one claude process)."""

from __future__ import annotations

import glob
import json
import os

from .events import parse_file


def append(path: str, record: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(record, sort_keys=True) + "\n")


def records(path: str) -> list[dict]:
    if not os.path.exists(path):
        return []
    out = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return out


def total(path: str) -> float:
    return sum(float(r.get("cost_usd") or 0) for r in records(path))


def unrecorded_logs(path: str, results_dir: str) -> list[str]:
    """Logs with no ledger line (e.g. the supervisor itself was killed)."""
    seen = {r.get("log") for r in records(path)}
    return [f for f in sorted(glob.glob(os.path.join(results_dir, "*.jsonl")))
            if os.path.basename(f) != "ledger.jsonl" and os.path.basename(f) not in seen]


def reconcile(path: str, results_dir: str) -> int:
    """Add a ledger line for every log that lacks one. Returns how many were added."""
    added = 0
    for f in unrecorded_logs(path, results_dir):
        s = parse_file(f)
        append(path, segment_record(os.path.basename(f), s, exit_code=None, status="?", note="reconciled"))
        added += 1
    return added


def segment_record(log: str, s, exit_code, status: str, note: str = "") -> dict:
    return {
        "log": log,
        "start": s.first_ts,
        "end": s.last_ts,
        "cost_usd": round(s.cost, 6),
        "cost_by_model": {k: round(v, 6) for k, v in s.cost_by_model.items()},
        "turns": s.turns,
        "agents": s.agents_spawned,
        "lost_agents": [t.description for t in s.lost_agents],
        "killed_tasks": len(s.killed),
        "permission_denials": s.permission_denials,
        "terminal_reason": s.terminal_reason,
        "exit_code": exit_code,
        "status_after": status,
        "note": note,
    }


if __name__ == "__main__":  # `just spend`
    import subprocess as _sp

    from . import config as _cfg

    _root = _sp.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True).stdout.strip() or "."
    _c = _cfg.load(_root)
    _recs = records(_c.ledger_path)
    _total = total(_c.ledger_path)
    print(f"${_total:.2f} of ${_c.budget_usd:.2f} over {len(_recs)} segment(s); ${_c.budget_usd - _total:.2f} left")
