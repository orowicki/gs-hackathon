# Notes from the human

> Only the human writes here (the guard hook blocks the agent). The coordinator reads
> it at every resume. Use it for hints, corrections or "stop doing X".
> TOP PRIORITY: getting open PRs merged beats starting or continuing new work. At every
  resume, before any task work, run `gh pr list --author @me --state open` and for each PR
  that is failing checks, conflicting with main, or has requested changes: rebase onto
  origin/main, fix it, re-run the checks, re-verify and mark it ready. Read the failing CI
  log (`gh run view <id> --log-failed`) and fix the cause; never skip, delete or loosen a
  test to go green. Only when all your PRs are green and conflict-free, continue your task.
  If a PR is stuck on another person's PR or a question, say so in one PR comment and move on.
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
> API routes: never add routes to packages/api/src/server.ts. Add a file
  packages/api/src/routes/<name>.routes.ts with `export default { name, order?, handle }`
  (types in src/http.ts; see delivery.routes.ts). It is loaded automatically. Put the deps
  your route needs on Deps from that file with `declare module "../http.js" { interface
  Deps { ... } }`, not in http.ts. Helpers go in routes/<name>/. When rebasing onto this
  change, move your server.ts routes into such a file.
