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
> HACKATHON MODE: working features beat test coverage. In a feature task, write only a few
  small unit tests for the core logic (the main path plus the one most likely failure) to
  show it works. No exhaustive edge cases, and no new integration, e2e or load suites unless
  the task is itself a test task. If something deserves bigger tests, propose a separate
  task (ap:proposed) and move on. Spend the time making the feature actually run in
  `just up` instead. Existing tests must still pass (see TOP PRIORITY above).
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
> UI is hand-built by the people now. Do not change anything under packages/web/ or
  docs/design/UI.md, and don't claim or propose UI tasks. If backend work needs a UI change
  (a new field to show, a new page), finish the backend part and file an issue describing
  the UI change, without the ap:task label. Keep the API the UI uses backwards compatible;
  if you must change a response shape, say so under "Contract change" in the PR.
  Your focus, in this order:
  1. INTEGRATION FIRST: the whole pipeline must work in the running app (`just up`), not
     only in tests: event in -> parsed -> schema-mapped -> rule matched -> alert stored ->
     notification delivered (ui + ntfy) -> runbook. Wire each package into the real entry
     points (packages/api/src/main.ts, the compose `worker` service), never only into test
     helpers. If a test helper wires something the running app doesn't, that is a bug in
     the app: fix it there (example: schema mapping, #91). Check by hand once: `just up`,
     `just demo`, then see alerts in GET /api/alerts. A broken link in this chain beats
     every other task, including your current one.
  2. Backend correctness and the demo data path (seed, `just demo`, engine worker).
  3. Good endpoints for the UI: everything a page needs in one call where sensible (lists
     with filtering, sorting and paging; counts/summaries such as open alerts per severity;
     detail views with related data), consistent error shapes, and every endpoint in the
     OpenAPI spec (/api/openapi.json) with request/response schemas and examples.
  4. Documentation of everything that exists: README quick start, architecture overview,
     API reference (generated from or checked against OpenAPI), config file formats,
     how to add a source / schema / channel / action type. Fill gaps; keep docs true.
  5. End-to-end tests and performance numbers.
