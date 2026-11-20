"""How the autopilot speaks: one vocabulary and one shape for every channel.

The agent follows the same rules from skills/autopilot/VOICE.md. Keep the two in step.

Principles: lead with the reader's next step; one speaker ("Autopilot · @login"); the
reader's words, not internal ones; evidence anyone can open; one message per event (edit
to correct); short; a GitHub alert box only when a person has to act. No emoji: status
comes from each channel's own tools (ntfy priority, click and buttons; GitHub alerts and
labels; terminal colour).
"""

from __future__ import annotations

from dataclasses import dataclass, field

# Internal STATE status -> the six words humans see.
STATUS_WORDS = {
    "DONE": "Done",
    "RUNNING": "Working",
    "RESUME": "Working",
    "WAITING": "Needs your answer",
    "REVIEW": "Ready for review",
    "BLOCKED": "Blocked",
    "BUDGET": "Budget used up",
}
WORDS = tuple(dict.fromkeys(STATUS_WORDS.values()))

# Terminal colour per word (rich style names); the word alone still carries the meaning.
STYLE = {"Done": "bold green", "Working": "bold cyan", "Needs your answer": "bold yellow",
         "Ready for review": "bold cyan", "Blocked": "bold red", "Budget used up": "bold yellow"}

# ntfy priority: your turn = high (sound/vibration); informational = default (quiet).
PRIORITY = {"Needs your answer": "high", "Blocked": "high", "Budget used up": "high",
            "Ready for review": "default", "Done": "default", "Working": "low"}

# Notification titles: one keyword, readable in a glance on a locked phone.
KEYWORD = {"Needs your answer": "Question", "Budget used up": "Budget", "Blocked": "Blocked",
           "Done": "Done", "Ready for review": "Review", "Working": "Working"}
LINE = 45  # characters per body line on a collapsed phone notification


def word(status: str) -> str:
    return STATUS_WORDS.get(status.upper(), status.capitalize())


def signature(login: str = "") -> str:
    return f"Autopilot · @{login}" if login else "Autopilot"


# ---- GitHub ------------------------------------------------------------------------
def comment(status: str, headline: str, lines: list[str] = (), *, login: str = "",
            alert: str = "", alert_kind: str = "IMPORTANT", tasks: list[str] = (),
            details: str = "", details_title: str = "How it was checked", marker: str = "") -> str:
    """A GitHub comment: bold status + headline, an optional alert (only when a person must
    act), short lines, optional task list, folded details, signature. `marker` is a hidden
    machine marker (<!-- ap-… -->)."""
    out = [marker] if marker else []
    out.append(f"**{word(status)}** · {headline}".rstrip(" ·"))
    if alert:
        out += ["", f"> [!{alert_kind}]", f"> {alert}"]
    if lines:
        out += [""] + list(lines)
    if tasks:
        out += [""] + [f"- [ ] {t}" for t in tasks]
    if details:
        out += ["", f"<details><summary>{details_title}</summary>", "", "```", details.strip(), "```", "", "</details>"]
    out += ["", f"<sub>{signature(login)}</sub>"]
    return "\n".join(out)


def decision_issue(question: str, options: dict[str, str], default: str | None, context: str,
                   if_unanswered: str, login: str) -> str:
    """Body of a question issue for one human."""
    opts = []
    for k, v in options.items():
        opts.append(f"- **{k}{' (default)' if k == default else ''}** {v}")
    how = [f"To answer: give this issue a thumbs-up for the default" if default else "To answer:",
           "comment `answer: B` (a letter or your own words)",
           "a teammate can unblock you with `delegate answer: …`"]
    return "\n".join([
        "> [!IMPORTANT]",
        f"> @{login}, your autopilot needs an answer. It keeps working on other parts meanwhile.",
        "",
        context.strip(),
        "",
        *opts,
        "",
        f"If nobody answers: {if_unanswered.strip()}" if if_unanswered else "",
        "",
        " · ".join(how),
        "",
        f"<sub>{signature(login)}</sub>",
    ]).replace("\n\n\n", "\n\n")


# ---- notifications ---------------------------------------------------------------------
@dataclass
class Note:
    title: str
    body: str
    priority: str = "default"
    tags: list[str] = field(default_factory=list)
    click: str = ""
    actions: list[tuple[str, str]] = field(default_factory=list)  # (label, url)


def clip(text: str, limit: int) -> str:
    """Cut at a word boundary, with an ellipsis when something was dropped."""
    text = " ".join(text.split())
    if len(text) <= limit:
        return text
    cut = text[:limit - 1].rsplit(" ", 1)[0].rstrip(",;:·-")
    return cut + "…"


def project_name(repo: str, override: str = "") -> str:
    """Short project name for titles: the override, else the repo name minus an `autopilot-` prefix."""
    if override:
        return override
    name = repo.split("/")[-1] if repo else "autopilot"
    return name.removeprefix("autopilot-") or name


def note(status: str, project: str, lines: list[tuple[str, int]], *, click: str = "",
         actions: list[tuple[str, str]] = ()) -> Note:
    """Title `<keyword> · <project>`; body lines given as (text, max lines), each clipped to
    fit a collapsed phone notification (LINE characters per line)."""
    w = word(status)
    body = "\n".join(clip(t, LINE * n) for t, n in lines if t)
    return Note(title=f"{KEYWORD.get(w, w)} · {project}", body=body, priority=PRIORITY.get(w, "default"),
                tags=[], click=click, actions=list(actions)[:3])


# ---- console -------------------------------------------------------------------------
def console(text: str, status: str = "") -> str:
    """One console line as rich markup: [status word in colour]  text."""
    if not status:
        return text
    w = word(status)
    return f"[{STYLE.get(w, 'bold')}]{w}[/]   {text}"
