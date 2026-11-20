"""Notifications: terminal bell, desktop (host only), ntfy webhook (URL from env)."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import json
import urllib.parse
import urllib.request


def ntfy_payload(url: str, title: str, body: str, priority: str, tags: list[str], click: str,
                 actions: list[tuple[str, str]]) -> tuple[str, dict]:
    """ntfy's JSON API (POST to the server root): UTF-8 titles, click URL and view buttons."""
    u = urllib.parse.urlsplit(url)
    topic = u.path.strip("/").split("/")[-1]
    payload = {"topic": topic, "title": title, "message": body[:3000], "tags": tags,
               "priority": {"min": 1, "low": 2, "default": 3, "high": 4, "max": 5, "urgent": 5}.get(priority, 3)}
    if click:
        payload["click"] = click
    if actions:
        payload["actions"] = [{"action": "view", "label": lbl, "url": href} for lbl, href in actions[:3]]
    return f"{u.scheme}://{u.netloc}/", payload


def notify(title: str, body: str, *, desktop: bool = True, ntfy_env: str = "AUTOPILOT_NTFY_URL",
           priority: str = "default", tags: list[str] | None = None, click: str = "",
           actions: list[tuple[str, str]] | None = None) -> list[str]:
    sent = []
    sys.stdout.write("\a")
    sys.stdout.flush()
    if desktop and not (os.path.exists("/.dockerenv") or os.path.exists("/run/.containerenv")):
        try:
            if sys.platform == "darwin" and shutil.which("osascript"):
                script = f'display notification {_q(body[:200])} with title {_q(title)}'
                subprocess.run(["osascript", "-e", script], timeout=10, check=False, capture_output=True)
                sent.append("desktop")
            elif shutil.which("notify-send"):
                subprocess.run(["notify-send", title, body[:200]], timeout=10, check=False)
                sent.append("desktop")
        except (OSError, subprocess.SubprocessError):
            pass
    url = os.environ.get(ntfy_env, "").strip()
    if url:
        try:
            root, payload = ntfy_payload(url, title, body, priority, tags or ["autopilot"], click, actions or [])
            req = urllib.request.Request(root, data=json.dumps(payload).encode(), method="POST",
                                         headers={"Content-Type": "application/json"})
            urllib.request.urlopen(req, timeout=10).read()
            sent.append("ntfy")
        except Exception as e:  # noqa: BLE001 - notification must never crash the run
            print(f"autopilot: phone notification failed ({e})", file=sys.stderr)
    return sent


def _q(s: str) -> str:
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def send(n, *, desktop: bool = True, ntfy_env: str = "AUTOPILOT_NTFY_URL", dedupe_path: str = "",
         window_h: float = 24) -> list[str]:
    """Send a voice.Note, unless the same title and text went out in the last `window_h` hours
    (ntfy.sh's free tier limits messages per IP per day, shared by everyone in an office)."""
    if dedupe_path:
        import hashlib
        import time as _t
        key = hashlib.sha1(f"{n.title}\n{n.body}".encode()).hexdigest()[:16]
        try:
            sent = json.load(open(dedupe_path))
        except (OSError, ValueError):
            sent = {}
        now = _t.time()
        sent = {k: v for k, v in sent.items() if now - v < window_h * 3600}
        if key in sent:
            return []
        sent[key] = now
        try:
            os.makedirs(os.path.dirname(dedupe_path), exist_ok=True)
            json.dump(sent, open(dedupe_path, "w"))
        except OSError:
            pass
    return notify(n.title, n.body, desktop=desktop, ntfy_env=ntfy_env, priority=n.priority,
                  tags=n.tags, click=n.click, actions=n.actions)
