# Settings

## SPEC frontmatter (`docs/autopilot/SPEC.md`)
| Key | Meaning |
|---|---|
| `ready` | `true` when the SPEC is complete; runs refuse otherwise |
| `profile` | `core`, `hackathon` or `research` |
| `budget_usd` | total Claude spend for the whole build, all runs |

SPEC sections the kit reads beyond the text: `## Milestones` (`M1 name: what`; team mode makes GitHub milestones from them).

## `autopilot.toml`
Human-owned; the AI can't edit it.

### `[run]`
| Key | Default | Meaning |
|---|---|---|
| `model` | `opus` | the coordinator's model (agents choose their own) |
| `max_turns` | 400 | turns per run |
| `min_segment_usd` | 0.5 | don't start a run with less than this left |
| `budget_margin_usd` | 0.5 | per-run cap = what's left minus this |
| `idle_timeout_min` | 20 | watchdog: no output and no agents running this long, kill |
| `silent_timeout_min` | 60 | watchdog: no output at all this long, even with agents listed, kill |
| `unknown_segment_usd` | 1.0 | charged for a killed run whose real cost was never reported |
| `exit_grace_s` | 120 | finished but the process didn't exit: kill after this |
| `max_no_progress` | 2 | runs without a new commit or journal entry before Blocked |
| `backoff_s` | `[10, 60, 300]` | waits between runs after no progress |
| `bg_wait_ceiling_ms` | 1800000 | how long a run waits for background agents after its last turn |

### `[gate]`
| `gate` | `just lint;;just test` | checks that must pass before a run may say Working/Done (`;;`-separated) |

### `[env]`
| `required_env` | `[]` | env-file keys the project needs (e.g. `["OPENROUTER_API_KEY"]`); checked before spending anything |

### `[notify]`
| Key | Default | Meaning |
|---|---|---|
| `desktop_notify` | true | desktop notifications on the host |
| `ntfy_env` | `AUTOPILOT_NTFY_URL` | which env var holds the ntfy URL |
| `name` | repo name | short project name in notification titles |
| `notify_done` | false | also send a phone notification when a run finishes |

### `[launch]`
| `plugin_dir` | `.autopilot/plugin` | the vendored kit |
| `tested_claude_version` | | the Claude Code version the kit was tested with; doctor warns on a different one |

### `[team]`
| Key | Default | Meaning |
|---|---|---|
| `enabled` | false | team mode |
| `repo` | the origin remote | `owner/name` |
| `poll_minutes` | 5 | how often `--wait` checks GitHub |
| `max_open_claims` | 1 | tasks one autopilot holds at once |
| `heartbeat_minutes` | 20 | claim refresh while a run works |
| `max_proposals` | 5 | proposed issues per run; extras are parked |
| `claim_expiry_h` | 24 (2 for hackathon) | claim expires without a heartbeat; `ap:hold` pauses it |
| `discussions` | `Autopilot` | Discussions category for team notes; `""` turns notes off |
| `max_notes` | 3 | team notes one autopilot may post per run |
| `auto_merge` | on for hackathon, off otherwise | merge your autopilot's PRs that need no review (see github.md) |
| `auto_merge_delay_min` | 5 | minutes after the Merging notification in which any comment stops it |
| `auto_promote` | on for hackathon, off otherwise | your autopilot's proposals become `ap:task` unless someone comments or thumbs-downs them |
| `auto_promote_delay_min` | 10 | minutes before a proposal becomes a task |

## Env-file (`~/.config/autopilot/<project>.env`)
`GH_TOKEN`, `AUTOPILOT_NTFY_URL`, keys from `required_env`, optionally `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`. Changes need the container recreated (`ap setup` does it).
