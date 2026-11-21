# Notes from the human

> Only the human writes here (the guard hook blocks the agent). The coordinator reads
> it at every resume. Use it for hints, corrections or "stop doing X".
> Root package.json must never list packages by name. Each package defines its own
  "build" and "typecheck" scripts; the root runs them with --workspaces --if-present.
> On rebase conflicts in package-lock.json: take main's version, then run `npm install`.
  Never hand-edit the lockfile.
> Merge by default. Mark PRs "Review: not needed" when checks pass. Take the recommended
  default for any choice, record it in the PR body and JOURNAL, and move on: don't ask for
  review just to confirm a default. CI runs Postgres + Redis, so a green CI covers the
  integration tests; the devcontainer has them too (DATABASE_URL / REDIS_URL).
  Use "Review: needed" only for a "Contract change" to docs/autopilot/interfaces/ or a
  protected file.
> If you need a person to set something up (a service, a secret, an env var, a tool, a
  permission, a firewall domain), don't work around it and don't park it in a PR review:
  stop and ask a question (ap:decision) that says exactly what to set up, then wait.
> Never wait with sleep/poll loops (`sleep`, `until ...; do sleep`, watching files or
  output). To run subagents in parallel, start them all as foreground Agent calls in ONE
  message: they run concurrently and you get every result when they finish. Same for
  tests and builds: run them in the foreground with a timeout.
