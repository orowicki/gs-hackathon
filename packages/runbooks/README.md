# @alerting/runbooks

Runbooks for alerts: matching, templating, automation runs with approvals, and an audit log.

- Text runbooks show instructions; automation runbooks run steps (`http`, `escalate`, `wait`).
- `createRunbookRegistry` keeps validated runbooks live from the config store (`kind: runbook`).
- `createRunner` executes steps, pauses on `approval: required`, records every step in the audit log, and uses compare-and-set saves so only one approver wins. `runner.recoverStale()` fails runs left "running" by a crashed process (called once at startup in the API).
- Stores: `createMemoryRunStore` (tests) and `createPgRunStore(pool, { ready })` (pass the `migrateRunbooks(pool)` promise as `ready`).

## YAML format

Files live in `config/runbooks/*.yaml`.

```yaml
id: settlement-timeout
name: Settlement timeout
type: automation          # or "text" (then `content:` instead of `steps:`)
matches: type = WORKFLOW_FAILED AND labels.service = settlement
steps:
  - name: Retry workflow {{workflowId}}
    action: http
    method: POST
    url: http://demo-service:4100/workflows/{{workflowId}}/retry
    headers: { x-id: "{{workflowId}}" }
    approval: required    # default "none"
  - action: wait
    duration: 30s         # max 15m, validated by validateRunbook
  - action: escalate
    group: payments-oncall
```

URL placeholders are `encodeURIComponent`-encoded and not allowed in the scheme/host/port part. HTTP steps do not follow redirects, read at most 64 KiB of the response and strip CR/LF from header values.

## Action plugins

An action is `{ type, execute(step, ctx) => Promise<{ ok, result }> }`. Add one with `registry.register(plugin)` on the registry from `createActionRegistry` / `createDefaultActions`, then use `action: <type>` in a step.

## Routes (`createRunbookRoutes`)

- `GET /api/alerts/{id}/runbook-runs`, `GET /api/alerts/{id}/audit`
- `GET /api/approvals`, `GET /api/audit?alertId=&limit=`
- `POST /api/alerts/{id}/runbook-steps/{stepIndex}/approve` body `{ actor?, runbookId?, decision?: "approve" | "skip" }`. Returns 200 with the run, or 202 with the current run state if the continuation takes longer than `respondWithinMs` (default 5000).

`handle` returns `false` for paths it does not own so the server falls through to other routes.

## Notes

- `actor` is taken from the request body/query without authentication (no auth is in scope).
- The alert-stream worker (`startRunbookWorker`) is not started in the API `main.ts` yet, because no alerts store exists on main.
