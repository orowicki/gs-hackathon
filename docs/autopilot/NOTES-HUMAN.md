# Notes from the human

> Only the human writes here (the guard hook blocks the agent). The coordinator reads
> it at every resume. Use it for hints, corrections or "stop doing X".
- Root package.json must never list packages by name. Each package defines its own
  "build" and "typecheck" scripts; the root runs them with --workspaces --if-present.
- On rebase conflicts in package-lock.json: take main's version, then run `npm install`.
  Never hand-edit the lockfile.
